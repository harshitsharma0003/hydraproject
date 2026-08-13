'use strict';

const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { pool, withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { rateLimit } = require('../ratelimit');
const intentLib = require('../intent');
const { retrieve } = require('../retrieval');
const meter = require('../meter');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOKEN_TTL_MIN = parseInt(process.env.TOKEN_TTL_MINUTES || '30', 10);
const CACHE_TTL_S = parseInt(process.env.QUERY_CACHE_TTL_SECONDS || '3600', 10);

async function loadTaxonomy(siteId, locale) {
  const { rows } = await pool.query(
    `SELECT * FROM taxonomy_profiles
      WHERE site_id = $1 AND locale = $2
      ORDER BY version DESC LIMIT 1`, [siteId, locale]);
  return rows[0] || null;
}

router.post('/query', versionGate, requireKey('publishable'), rateLimit, async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.hydra;
  const { q, locale, currency, priorIntent } = req.body || {};

  if (!q || typeof q !== 'string') {
    return res.json({ ok: false, error: 'empty_query' });
  }

  if (await meter.overQuota(tenantId, req.hydra.monthly_query_quota,
                            req.hydra.overage_allowed)) {
    // Soft-fail. The storefront falls back to native search.
    return res.status(200).json({ ok: false, error: 'quota_exceeded' });
  }

  const profile = await loadTaxonomy(siteId, locale);
  if (!profile) return res.json({ ok: false, error: 'not_synced' });

  const normalised = intentLib.normaliseQuery(q);
  const key = intentLib.cacheKey({
    normalised, promptHash: profile.prompt_hash, rulesVersion: '1'
  });

  let intent = null;
  let masterIds = null;
  let relaxed = null;
  let usage = null;
  let cached = false;

  // "office wear" resolves identically for every shopper on this site. At a
  // healthy hit rate you only pay a model provider on a minority of queries.
  if (!priorIntent) {
    const hit = await withTenant(tenantId, (c) => c.query(
      `SELECT intent, candidate_ids FROM query_cache
        WHERE tenant_id=$1 AND site_id=$2 AND locale=$3 AND cache_key=$4
          AND expires_at > now()`, [tenantId, siteId, locale, key]));
    if (hit.rows[0]) {
      intent = hit.rows[0].intent;
      masterIds = hit.rows[0].candidate_ids;
      cached = true;
    }
  }

  if (!intent) {
    try {
      const parsed = await intentLib.resolveIntent(anthropic, {
        query: q,
        profile: {
          refinements: profile.refinements,
          category_tree: profile.category_tree,
          price_bands: profile.price_bands,
          has_giftcard: profile.has_giftcard,
          has_giftwrap: profile.has_giftwrap
        },
        priorIntent: priorIntent || null,
        currency: currency || 'INR'
      });
      intent = parsed.intent;
      usage = parsed.usage;
    } catch (e) {
      return res.json({ ok: false, error: 'intent_failed' });
    }

    const r = await retrieve({ tenantId, siteId, locale, intent, queryText: q });
    masterIds = r.masterIds;
    relaxed = r.relaxed;

    if (!priorIntent) {
      await withTenant(tenantId, (c) => c.query(
        `INSERT INTO query_cache (tenant_id, site_id, locale, cache_key,
                                  normalised_q, intent, candidate_ids, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' seconds')::interval)
         ON CONFLICT (tenant_id, site_id, locale, cache_key)
         DO UPDATE SET hit_count = query_cache.hit_count + 1`,
        [tenantId, siteId, locale, key, normalised,
         JSON.stringify(intent), masterIds, String(CACHE_TTL_S)]));
    }
  }

  if (!masterIds.length) {
    return res.json({ ok: false, error: 'no_results', intent });
  }

  const token = crypto.randomBytes(9).toString('base64url');
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO query_tokens (token, tenant_id, site_id, locale, master_ids,
                               intent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
    [token, tenantId, siteId, locale, masterIds,
     JSON.stringify(intent), String(TOKEN_TTL_MIN)]));

  meter.record(tenantId, siteId, { cached, usage,
    environment: req.hydra.environment,
    billable: req.hydra.billable }).catch(() => {});

  // Narration is tier-gated: it roughly doubles per-query model cost and is
  // the cleanest lever available.
  if (!req.hydra.narration_enabled) delete intent.narration;

  res.json({
    ok: true,
    token,
    masterIds,
    intent,
    relaxed,
    cached
  });
});

module.exports = router;
