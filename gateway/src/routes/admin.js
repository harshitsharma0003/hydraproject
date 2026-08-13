'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');
const { pool, withTenant } = require('../db');

const router = express.Router();

/** Console session. Real deployments should back this with SSO. */
function requireConsole(req, res, next) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false });
  try {
    req.console = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ ok: false });
  }
}

router.post('/console/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query(
    `SELECT u.id, u.tenant_id, u.email
       FROM console_users u
      WHERE u.email = $1 AND u.password_hash = crypt($2, u.password_hash)`,
    [email, password]);
  if (!rows[0]) return res.status(401).json({ ok: false, error: 'invalid_credentials' });

  const token = jwt.sign(
    { sub: rows[0].id, tenantId: rows[0].tenant_id, email: rows[0].email },
    process.env.JWT_SECRET, { expiresIn: '12h' });
  res.json({ ok: true, token, email: rows[0].email });
});

router.get('/console/sites', requireConsole, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, (SELECT findings FROM health_reports h
                   WHERE h.site_id = s.id ORDER BY created_at DESC LIMIT 1) AS findings
       FROM sites s WHERE s.tenant_id = $1`, [req.console.tenantId]);
  res.json({ ok: true, sites: rows });
});

router.get('/console/rules', requireConsole, async (req, res) => {
  const rows = await withTenant(req.console.tenantId, (c) => c.query(
    `SELECT * FROM merch_rules WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [req.console.tenantId]));
  res.json({ ok: true, rules: rows.rows });
});

router.post('/console/rules', requireConsole, async (req, res) => {
  const { siteId, kind, masterId, attrMatch, queryPattern, multiplier,
          pinPosition, reason, expiresAt } = req.body || {};
  await withTenant(req.console.tenantId, (c) => c.query(
    `INSERT INTO merch_rules (tenant_id, site_id, kind, master_id, attr_match,
        query_pattern, multiplier, pin_position, reason, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
    [req.console.tenantId, siteId, kind, masterId || null,
     attrMatch ? JSON.stringify(attrMatch) : null, queryPattern || null,
     multiplier || 1.0, pinPosition || null, reason || null,
     req.console.email, expiresAt || null]));
  // Rules change ranking, so cached candidate lists are now wrong.
  await withTenant(req.console.tenantId, (c) => c.query(
    'DELETE FROM query_cache WHERE tenant_id=$1', [req.console.tenantId]));
  res.json({ ok: true });
});

router.delete('/console/rules/:id', requireConsole, async (req, res) => {
  await withTenant(req.console.tenantId, (c) => c.query(
    'DELETE FROM merch_rules WHERE tenant_id=$1 AND id=$2',
    [req.console.tenantId, req.params.id]));
  res.json({ ok: true });
});

/**
 * The screen merchandisers actually log in for: queries that returned nothing
 * or had to be widened. Each row is a catalog gap, a vocabulary gap, or a
 * taxonomy gap.
 */
router.get('/console/queries', requireConsole, async (req, res) => {
  const rows = await withTenant(req.console.tenantId, (c) => c.query(
    `SELECT payload->>'q' AS query,
            count(*) AS hits,
            sum(CASE WHEN payload->>'relaxed' IS NOT NULL THEN 1 ELSE 0 END) AS widened,
            max(occurred_at) AS last_seen
       FROM visitor_events
      WHERE tenant_id=$1 AND kind='query'
        AND occurred_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY widened DESC, hits DESC LIMIT 200`,
    [req.console.tenantId]));
  res.json({ ok: true, queries: rows.rows });
});

router.get('/console/syncs', requireConsole, async (req, res) => {
  const rows = await withTenant(req.console.tenantId, (c) => c.query(
    `SELECT j.*, (SELECT count(*)::int FROM embed_queue q WHERE q.job_id = j.id)
              AS embed_remaining
       FROM ingest_jobs j WHERE j.tenant_id = $1
      ORDER BY j.created_at DESC LIMIT 50`, [req.console.tenantId]));
  res.json({ ok: true, jobs: rows.rows });
});

/**
 * Sandbox caches never expire, which is exactly wrong while someone is
 * iterating on prompts or catalog data. This is the escape hatch.
 */
router.post('/console/cache/flush', requireConsole, async (req, res) => {
  const { siteId } = req.body || {};
  const { rows: [site] } = await pool.query(
    'SELECT id, environment FROM sites WHERE id=$1 AND tenant_id=$2',
    [siteId, req.console.tenantId]);
  if (!site) return res.status(404).json({ ok: false });

  const { rows: [r] } = await pool.query('SELECT cache_flush($1) AS n', [siteId]);
  res.json({ ok: true, flushed: Number(r.n), environment: site.environment });
});

router.get('/console/environments', requireConsole, async (req, res) => {
  const rows = await withTenant(req.console.tenantId, (c) => c.query(
    `SELECT * FROM environment_cost WHERE tenant_id=$1
      ORDER BY period DESC, environment`, [req.console.tenantId]));
  res.json({ ok: true, environments: rows.rows });
});

router.get('/console/usage', requireConsole, async (req, res) => {
  const rows = await withTenant(req.console.tenantId, (c) => c.query(
    `SELECT period, sum(queries_total) AS queries, sum(queries_cached) AS cached,
            sum(cost_micros)/1000000.0 AS cost
       FROM usage_meter WHERE tenant_id=$1
      GROUP BY period ORDER BY period DESC LIMIT 12`,
    [req.console.tenantId]));
  res.json({ ok: true, usage: rows.rows });
});

module.exports = { router, requireConsole };
