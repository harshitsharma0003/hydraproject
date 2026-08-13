'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireKey } = require('../auth');

const router = express.Router();

/**
 * Authenticated health probe. Called by Hydra-Health in Business Manager so
 * support can diagnose without instance access.
 */
router.post('/health', requireKey('secret'), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.hydra;

  const [{ rows: counts }, { rows: syncs }, { rows: tax }] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS embedded,
                       count(*) AS total
                  FROM products WHERE tenant_id=$1 AND site_id=$2`, [tenantId, siteId]),
    pool.query(`SELECT kind, status, rows_seen, rows_embedded, finished_at
                  FROM sync_runs WHERE tenant_id=$1 AND site_id=$2
                 ORDER BY started_at DESC LIMIT 1`, [tenantId, siteId]),
    pool.query(`SELECT version, built_at,
                       (SELECT count(*) FROM jsonb_object_keys(refinements)) AS attribute_count
                  FROM taxonomy_profiles
                 WHERE site_id = $1
                 ORDER BY version DESC LIMIT 1`, [siteId])
  ]);

  res.json({
    ok: true,
    gatewayVersion: '1.0.0',
    api: 'v1',
    tier: req.hydra.tier,
    licenseStatus: req.hydra.status,
    narrationEnabled: req.hydra.narration_enabled,
    catalog: {
      total: Number(counts[0]?.total || 0),
      embedded: Number(counts[0]?.embedded || 0)
    },
    lastSync: syncs[0] || null,
    taxonomy: tax[0]
      ? { version: tax[0].version,
          attributeCount: Number(tax[0].attribute_count),
          builtAt: tax[0].built_at }
      : null
  });
});

module.exports = router;
