'use strict';

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { pool, withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { rateLimit } = require('../ratelimit');
const meter = require('../meter');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.NARRATION_MODEL || 'claude-sonnet-4-6';

/**
 * Editorial line above the grid.
 *
 * Deliberately a separate endpoint rather than part of /v1/query: the grid must
 * paint as soon as products are ready, and prose is worth 1-2 seconds only if
 * it costs nothing to wait for. The widget fires this after render and fills
 * the line in when it arrives.
 *
 * Tier-gated - it roughly doubles per-query model cost.
 */
router.post('/narrate', versionGate, requireKey('publishable'), rateLimit,
  async (req, res) => {
    const { tenant_id: tenantId, site_id: siteId } = req.hydra;
    if (!req.hydra.narration_enabled) {
      return res.json({ ok: false, error: 'not_enabled' });
    }

    const { token } = req.body || {};
    const { rows } = await withTenant(tenantId, (c) => c.query(
      `SELECT intent, master_ids FROM query_tokens
        WHERE token=$1 AND tenant_id=$2 AND expires_at > now()`, [token, tenantId]));
    const t = rows[0];
    if (!t) return res.json({ ok: false, error: 'expired' });

    // A handful of real titles, so the line describes what is on screen rather
    // than restating the query back at the shopper.
    const { rows: sample } = await withTenant(tenantId, (c) => c.query(
      `SELECT title, brand FROM products
        WHERE tenant_id=$1 AND site_id=$2 AND master_id = ANY($3) LIMIT 8`,
      [tenantId, siteId, t.master_ids.slice(0, 8)]));

    try {
      const r = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 120,
        system: [{
          type: 'text',
          cache_control: { type: 'ephemeral' },
          text: 'You write one sentence above a product grid on a fashion '
              + 'retailer\'s site. Describe what was found, warmly and plainly. '
              + 'No sales language, no exclamation marks, no emoji. Never invent '
              + 'a product claim, a price or a discount. Never mention any '
              + 'personal attribute the shopper described. Under 25 words.'
        }],
        messages: [{
          role: 'user',
          content: `Understood: ${JSON.stringify(t.intent.hardFilters || {})}\n`
                 + `Style notes: ${(t.intent.softSignals || []).join(', ')}\n`
                 + `Showing: ${sample.map((p) => p.title).join('; ')}`
        }]
      });

      const text = r.content.find((c) => c.type === 'text')?.text?.trim() || '';
      meter.record(tenantId, siteId, { cached: false, usage: r.usage,
        environment: req.hydra.environment, billable: false }).catch(() => {});

      res.json({ ok: true, narration: text });
    } catch (e) {
      // Prose is optional. A failure here must never surface to the shopper.
      res.json({ ok: false, error: 'narration_failed' });
    }
  });

module.exports = router;
