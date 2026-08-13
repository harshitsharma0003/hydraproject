'use strict';

const express = require('express');
const { withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');

const router = express.Router();

/**
 * Attribution chain. Billing is on queries in v1, but this is emitted from day
 * one so performance pricing is a pricing-page change later, not a
 * re-instrumentation project.
 */
router.post('/event', versionGate, requireKey(), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.hydra;
  const { token, kind, masterId, payload, visitorId, orderValue, currency } = req.body || {};

  const allowed = ['query', 'chip', 'impression', 'click', 'add_to_cart', 'order'];

  // Erasure requests arrive here from Shopify's compliance webhooks.
  if (kind === 'redact' && visitorId) {
    await withTenant(tenantId, (c) =>
      c.query('SELECT hydra_forget($1,$2)', [tenantId, visitorId]));
    return res.json({ ok: true, redacted: true });
  }

  if (!allowed.includes(kind)) return res.json({ ok: true, ignored: true });

  await withTenant(tenantId, (c) => c.query(
    `INSERT INTO visitor_events (tenant_id, visitor_id, site_id, kind,
        query_token, master_id, payload, order_value, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [tenantId, visitorId || '00000000-0000-0000-0000-000000000000',
     siteId, kind, token || null, masterId || null,
     JSON.stringify(payload || {}), orderValue || null, currency || null]));

  res.json({ ok: true });
});

module.exports = router;
