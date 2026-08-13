'use strict';

const express = require('express');
const { pool, withTenant } = require('../db');
const rbac = require('../rbac');

const router = express.Router();

/**
 * Role and status are resolved from the database per request by
 * rbac.authenticate, so this is a thin alias kept for the existing routes.
 */
const requireConsole = rbac.authenticate;

router.post('/console/login', async (req, res) => {
  const { email, password } = req.body || {};

  const { rows: [candidate] } = await pool.query(
    `SELECT id, tenant_id, email, role, status, locked_until, failed_logins,
            password_hash = crypt($2, password_hash) AS password_ok
       FROM console_users WHERE email = $1`, [email, password || '']);

  // Same response for every failure mode - a distinct "account locked" message
  // tells an attacker which addresses are real.
  const fail = () => res.status(401).json({ ok: false, error: 'invalid_credentials' });
  if (!candidate) return fail();
  if (candidate.locked_until && new Date(candidate.locked_until) > new Date()) return fail();

  if (!candidate.password_ok) {
    // Five failures locks the account for fifteen minutes.
    await pool.query(
      `UPDATE console_users
          SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= 5
                                  THEN now() + interval '15 minutes' END
        WHERE id = $1`, [candidate.id]);
    return fail();
  }
  if (candidate.status !== 'active') {
    return res.status(403).json({ ok: false, error: 'account_' + candidate.status });
  }

  await pool.query(
    `UPDATE console_users SET failed_logins=0, locked_until=NULL, last_login_at=now()
      WHERE id=$1`, [candidate.id]);

  rbac.audit({ user: candidate, ip: req.ip, get: (h) => req.get(h) }, 'user.login');

  res.json({ ok: true, token: rbac.issueToken(candidate.id),
             email: candidate.email, role: candidate.role });
});

router.get('/console/sites', requireConsole, rbac.require('sites:read'), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT s.*, (SELECT findings FROM health_reports h
                   WHERE h.site_id = s.id ORDER BY created_at DESC LIMIT 1) AS findings
       FROM sites s WHERE s.tenant_id = $1`, [req.user.tenant_id]);
  res.json({ ok: true, sites: rows });
});

router.get('/console/rules', requireConsole, rbac.require('rules:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT * FROM merch_rules WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [req.user.tenant_id]));
  res.json({ ok: true, rules: rows.rows });
});

router.post('/console/rules', requireConsole, rbac.require('rules:write'), rbac.requireSite, async (req, res) => {
  const { siteId, kind, masterId, attrMatch, queryPattern, multiplier,
          pinPosition, reason, expiresAt } = req.body || {};
  await withTenant(req.user.tenant_id, (c) => c.query(
    `INSERT INTO merch_rules (tenant_id, site_id, kind, master_id, attr_match,
        query_pattern, multiplier, pin_position, reason, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`,
    [req.user.tenant_id, siteId, kind, masterId || null,
     attrMatch ? JSON.stringify(attrMatch) : null, queryPattern || null,
     multiplier || 1.0, pinPosition || null, reason || null,
     req.user.email, expiresAt || null]));
  // Rules change ranking, so cached candidate lists are now wrong.
  await withTenant(req.user.tenant_id, (c) => c.query(
    'DELETE FROM query_cache WHERE tenant_id=$1', [req.user.tenant_id]));
  res.json({ ok: true });
});

router.delete('/console/rules/:id', requireConsole, rbac.require('rules:write'), async (req, res) => {
  await withTenant(req.user.tenant_id, (c) => c.query(
    'DELETE FROM merch_rules WHERE tenant_id=$1 AND id=$2',
    [req.user.tenant_id, req.params.id]));
  res.json({ ok: true });
});

/**
 * The screen merchandisers actually log in for: queries that returned nothing
 * or had to be widened. Each row is a catalog gap, a vocabulary gap, or a
 * taxonomy gap.
 */
router.get('/console/queries', requireConsole, rbac.require('queries:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT payload->>'q' AS query,
            count(*) AS hits,
            sum(CASE WHEN payload->>'relaxed' IS NOT NULL THEN 1 ELSE 0 END) AS widened,
            max(occurred_at) AS last_seen
       FROM visitor_events
      WHERE tenant_id=$1 AND kind='query'
        AND occurred_at > now() - interval '30 days'
      GROUP BY 1 ORDER BY widened DESC, hits DESC LIMIT 200`,
    [req.user.tenant_id]));
  res.json({ ok: true, queries: rows.rows });
});

router.get('/console/syncs', requireConsole, rbac.require('sync:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT j.*, (SELECT count(*)::int FROM embed_queue q WHERE q.job_id = j.id)
              AS embed_remaining
       FROM ingest_jobs j WHERE j.tenant_id = $1
      ORDER BY j.created_at DESC LIMIT 50`, [req.user.tenant_id]));
  res.json({ ok: true, jobs: rows.rows });
});

/**
 * Sandbox caches never expire, which is exactly wrong while someone is
 * iterating on prompts or catalog data. This is the escape hatch.
 */
router.post('/console/cache/flush', requireConsole, rbac.require('cache:flush'), rbac.requireSite, async (req, res) => {
  const { siteId } = req.body || {};
  const { rows: [site] } = await pool.query(
    'SELECT id, environment FROM sites WHERE id=$1 AND tenant_id=$2',
    [siteId, req.user.tenant_id]);
  if (!site) return res.status(404).json({ ok: false });

  const { rows: [r] } = await pool.query('SELECT cache_flush($1) AS n', [siteId]);
  res.json({ ok: true, flushed: Number(r.n), environment: site.environment });
});

router.get('/console/environments', requireConsole, rbac.require('sites:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT * FROM environment_cost WHERE tenant_id=$1
      ORDER BY period DESC, environment`, [req.user.tenant_id]));
  res.json({ ok: true, environments: rows.rows });
});

router.get('/console/usage', requireConsole, rbac.require('billing:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT period, sum(queries_total) AS queries, sum(queries_cached) AS cached,
            sum(cost_micros)/1000000.0 AS cost
       FROM usage_meter WHERE tenant_id=$1
      GROUP BY period ORDER BY period DESC LIMIT 12`,
    [req.user.tenant_id]));
  res.json({ ok: true, usage: rows.rows });
});

module.exports = { router, requireConsole };
