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

/**
 * Chip clicks and follow-up text.
 *
 * Deliberately NOT a local filter over the previous result set. The shopper's
 * second input is usually a modification ("something cheaper", "in navy"), which
 * only resolves correctly against the prior intent. Re-resolving also means
 * "office wear" + navy re-ranks semantically instead of just subsetting.
 *
 * Never cached: a refinement is by definition contextual to one session.
 */
router.post('/refine', versionGate, requireKey('publishable'), rateLimit, async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.algivo;
  const { token, chip, q, locale, currency, priorIntent } = req.body || {};

  // Prefer the server-side token record over anything the client sent.
  let prior = priorIntent || null;
  if (token) {
    const { rows } = await withTenant(tenantId, (c) => c.query(
      `SELECT intent, locale FROM query_tokens
        WHERE token = $1 AND tenant_id = $2 AND expires_at > now()`,
      [token, tenantId]));
    if (rows[0]) prior = rows[0].intent;
  }

  // A chip carries a known dimension and value, so it applies as a hard filter
  // with no model call at all - instant, and free.
  if (chip && typeof chip === 'object' && chip.dimension && chip.value && prior) {
    const merged = JSON.parse(JSON.stringify(prior));
    merged.hardFilters = merged.hardFilters || {};
    merged.hardFilters[chip.dimension] = [chip.value];
    merged.chipDimensions = (merged.chipDimensions || [])
      .filter((d) => d !== chip.dimension);

    const r = await retrieve({ tenantId, siteId, locale: locale || 'en',
                               intent: merged, queryText: '' });
    if (!r.masterIds.length) {
      return res.json({ ok: false, error: 'no_results' });
    }
    merged.chips = await buildChips({ tenantId, siteId, locale: locale || 'en',
      masterIds: r.masterIds, intent: merged }).catch(() => []);

    const t = crypto.randomBytes(9).toString('base64url');
    await withTenant(tenantId, (c) => c.query(
      `INSERT INTO query_tokens (token, tenant_id, site_id, locale, master_ids,
                                 intent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
      [t, tenantId, siteId, locale || 'en', r.masterIds,
       JSON.stringify(merged), String(TOKEN_TTL_MIN)]));

    return res.json({ ok: true, token: t, masterIds: r.masterIds,
                      intent: merged, relaxed: r.relaxed, freeRefinement: true });
  }

  const followUp = (typeof chip === 'string' ? chip : (q || '')).toString().slice(0, 400);
  if (!followUp) return res.json({ ok: false, error: 'empty_refinement' });

  const activeLocale = locale || 'en';
  const { rows: profiles } = await pool.query(
    `SELECT * FROM taxonomy_profiles
      WHERE site_id = $1 AND locale = $2 ORDER BY version DESC LIMIT 1`,
    [siteId, activeLocale]);
  const profile = profiles[0];
  if (!profile) return res.json({ ok: false, error: 'not_synced' });

  let intent;
  let usage;
  try {
    const parsed = await intentLib.resolveIntent(anthropic, {
      query: followUp,
      profile: {
        refinements: profile.refinements,
        category_tree: profile.category_tree,
        price_bands: profile.price_bands,
        has_giftcard: profile.has_giftcard,
        has_giftwrap: profile.has_giftwrap
      },
      priorIntent: prior,
      currency: currency || 'INR'
    });
    intent = parsed.intent;
    usage = parsed.usage;
  } catch (e) {
    return res.json({ ok: false, error: 'intent_failed' });
  }

  const { masterIds, relaxed } = await retrieve({
    tenantId, siteId, locale: activeLocale, intent, queryText: followUp
  });

  if (!masterIds.length) return res.json({ ok: false, error: 'no_results', intent });

  intent.chips = await buildChips({
    tenantId, siteId, locale: activeLocale, masterIds, intent }).catch(() => []);

  const newToken = crypto.randomBytes(9).toString('base64url');
  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO query_tokens (token, tenant_id, site_id, locale, master_ids,
                               intent, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
    [newToken, tenantId, siteId, activeLocale, masterIds,
     JSON.stringify(intent), String(TOKEN_TTL_MIN)]));

  meter.record(tenantId, siteId, { cached: false, usage,
    environment: req.algivo.environment,
    billable: req.algivo.billable }).catch(() => {});

  if (!req.algivo.narration_enabled) delete intent.narration;

  res.json({ ok: true, token: newToken, masterIds, intent, relaxed });
});

module.exports = router;
