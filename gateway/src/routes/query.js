'use strict';

const express = require('express');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const { pool, withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { rateLimit } = require('../ratelimit');
const intentLib = require('../intent');
const { retrieve } = require('../retrieval');
const { buildChips } = require('../chips');
const meter = require('../meter');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOKEN_TTL_MIN = parseInt(process.env.TOKEN_TTL_MINUTES || '30', 10);
const CACHE_TTL_S = parseInt(process.env.QUERY_CACHE_TTL_SECONDS || '3600', 10);

async function loadPolicy(siteId) {
  const { rows } = await pool.query(
    `SELECT (cache_policy($1)).*, candidate_limit_for($1) AS candidate_limit`, [siteId]);
  return rows[0] || { ttl_seconds: 3600, permanent: false, value_cap: null,
                      candidate_limit: 200 };
}

async function loadTaxonomy(siteId, locale) {
  const { rows } = await pool.query(
    `SELECT * FROM taxonomy_profiles
      WHERE site_id = $1 AND locale = $2
      ORDER BY version DESC LIMIT 1`, [siteId, locale]);
  return rows[0] || null;
}

router.post('/query', versionGate, requireKey('publishable'), rateLimit, async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.algivo;
  const { q, locale, currency, priorIntent, visitorId } = req.body || {};

  if (!q || typeof q !== 'string') {
    return res.json({ ok: false, error: 'empty_query' });
  }

  if (await meter.overQuota(tenantId, req.algivo.monthly_query_quota,
                            req.algivo.overage_allowed)) {
    // Soft-fail. The storefront falls back to native search.
    return res.status(200).json({ ok: false, error: 'quota_exceeded' });
  }

  const profile = await loadTaxonomy(siteId, locale);
  if (!profile) return res.json({ ok: false, error: 'not_synced' });

  const policy = await loadPolicy(siteId);

  /**
   * Personalisation.
   *
   * Deliberately NOT applied to gift queries. Someone shopping for their nephew
   * does not want their own browsing history steering the results, and the
   * intent parser already tells us which case this is.
   *
   * A personalised result set must also never enter the shared query cache -
   * one shopper's ranking would leak to everyone on the site. So a request that
   * uses a profile skips the cache in both directions.
   */
  let styleVector = null;
  if (visitorId) {
    const { rows: prof } = await withTenant(tenantId, (c) => c.query(
      `SELECT style_vector, click_count FROM visitor_profiles
        WHERE tenant_id=$1 AND visitor_id=$2 AND style_vector IS NOT NULL`,
      [tenantId, visitorId]));
    // Below a handful of clicks there is nothing reliable to learn.
    if (prof[0] && prof[0].click_count >= 3) styleVector = prof[0].style_vector;
  }

  // Non-production trims the taxonomy prompt to N values per attribute. Shape
  // is unchanged so intent resolution still behaves the same; only the cached
  // input volume shrinks.
  if (policy.value_cap) {
    profile.refinements = Object.fromEntries(
      Object.entries(profile.refinements || {}).map(([k, d]) => [k,
        { ...d, values: (d.values || []).slice(0, policy.value_cap) }]));
  }

  // Explicit bypass, for a developer iterating on prompts against a sandbox
  // whose cache never expires.
  const noCache = req.get('X-Algivo-No-Cache') === '1';

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
  // Intent resolution is still cacheable when personalised - only the retrieval
  // is shopper-specific - but the candidate list is not, so a personalised hit
  // reuses the parsed intent and re-runs retrieval.
  const personalised = !!styleVector;

  if (!priorIntent && !noCache) {
    const hit = await withTenant(tenantId, (c) => c.query(
      `SELECT intent, candidate_ids FROM query_cache
        WHERE tenant_id=$1 AND site_id=$2 AND locale=$3 AND cache_key=$4
          AND (expires_at IS NULL OR expires_at > now())`,
      [tenantId, siteId, locale, key]));
    if (hit.rows[0]) {
      intent = hit.rows[0].intent;
      cached = true;
      if (personalised && intent.queryType !== 'gift') {
        // Reuse the parsed intent, redo retrieval with their style vector.
        const r = await retrieve({ tenantId, siteId, locale, intent, queryText: q,
          candidateLimit: policy.candidate_limit, styleVector });
        masterIds = r.masterIds;
        relaxed = r.relaxed;
      } else {
        masterIds = hit.rows[0].candidate_ids;
      }
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

    let r;
    try {
      r = await retrieve({ tenantId, siteId, locale, intent, queryText: q,
        candidateLimit: policy.candidate_limit,
        // Never personalise a gift query - they are not shopping for themselves.
        styleVector: intent.queryType === 'gift' ? null : styleVector });
    } catch (e) {
      // Retrieval can fail on the query-embedding call (e.g. the provider rate-
      // limiting us). Degrade to native search - never let it crash the gateway.
      return res.json({ ok: false, error: 'degraded' });
    }
    masterIds = r.masterIds;
    relaxed = r.relaxed;

    // Only cache the unpersonalised candidate list. A personalised one would
    // leak one shopper's ranking to every other visitor on the site.
    if (!priorIntent && !personalised) {
      // NULL expires_at = permanent (sandbox). The purge job skips those.
      await withTenant(tenantId, (c) => c.query(
        `INSERT INTO query_cache (tenant_id, site_id, locale, cache_key,
                                  normalised_q, intent, candidate_ids, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
                 CASE WHEN $8::integer IS NULL THEN NULL
                      ELSE now() + ($8 || ' seconds')::interval END)
         ON CONFLICT (tenant_id, site_id, locale, cache_key)
         DO UPDATE SET intent = EXCLUDED.intent,
                       candidate_ids = EXCLUDED.candidate_ids,
                       expires_at = EXCLUDED.expires_at,
                       hit_count = query_cache.hit_count + 1`,
        [tenantId, siteId, locale, key, normalised,
         JSON.stringify(intent), masterIds,
         policy.permanent ? null : (policy.ttl_seconds || CACHE_TTL_S)]));
    }
  }

  if (!masterIds.length) {
    return res.json({ ok: false, error: 'no_results', intent });
  }

  // Values are counted from the products actually retrieved, so every chip is
  // guaranteed to return results. Cached intents get fresh chips too, because
  // the catalog may have moved since the intent was cached.
  intent.chips = await buildChips({ tenantId, siteId, locale, masterIds, intent })
    .catch(() => []);

  const token = crypto.randomBytes(9).toString('base64url');
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO query_tokens (token, tenant_id, site_id, locale, master_ids,
                               intent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
    [token, tenantId, siteId, locale, masterIds,
     JSON.stringify(intent), String(TOKEN_TTL_MIN)]));

  meter.record(tenantId, siteId, { cached, usage,
    environment: req.algivo.environment,
    billable: req.algivo.billable }).catch(() => {});

  // Narration is tier-gated: it roughly doubles per-query model cost and is
  // the cleanest lever available.
  if (!req.algivo.narration_enabled) delete intent.narration;

  res.json({
    ok: true,
    token,
    masterIds,
    intent,
    relaxed,
    cached,
    personalised,
    // Surfaced so a merchant can confirm at a glance which key they pasted.
    // Pasting the production key on a sandbox instance is a common mistake and
    // an expensive one.
    environment: req.algivo.environment
  });
});

module.exports = router;
