'use strict';

const express = require('express');
const crypto = require('crypto');
const { pool, withTenant } = require('../db');
const rbac = require('../rbac');
const mailer = require('../mailer');

const router = express.Router();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

router.use('/users', rbac.authenticate);
router.use('/audit', rbac.authenticate);

/* ------------------------------------------------------------------ */

router.get('/users', rbac.require('users:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    'SELECT * FROM user_directory WHERE tenant_id = $1 ORDER BY created_at',
    [req.user.tenant_id]));

  const { rows: invites } = await pool.query(
    `SELECT id, email, role, expires_at, created_at
       FROM user_invites
      WHERE tenant_id=$1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC`, [req.user.tenant_id]);

  const { rows: sites } = await pool.query(
    'SELECT id, external_site_id, environment FROM sites WHERE tenant_id=$1',
    [req.user.tenant_id]);

  res.json({
    ok: true,
    users: rows.rows,
    invites,
    sites,
    roles: rbac.ROLE_LABELS,
    me: { id: req.user.id, role: req.user.role }
  });
});

/**
 * Invite. The token is emailed and stored only as a hash - an invite link in an
 * inbox is a credential, so it gets the same treatment as an API key.
 */
router.post('/users/invite', rbac.require('users:write'), async (req, res) => {
  const { email, role = 'viewer', siteIds = [] } = req.body || {};
  if (!email || !rbac.PERMISSIONS[role]) {
    return res.status(400).json({ ok: false, error: 'invalid_input' });
  }
  // Only an owner can mint another owner. Otherwise an admin could escalate
  // themselves by inviting an owner account they control.
  if (role === 'owner' && req.user.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'only_owner_can_invite_owner' });
  }

  const { rows: dup } = await pool.query(
    'SELECT 1 FROM console_users WHERE tenant_id=$1 AND email=$2',
    [req.user.tenant_id, email]);
  if (dup.length) return res.status(409).json({ ok: false, error: 'already_a_member' });

  const token = crypto.randomBytes(32).toString('base64url');
  const { rows: [inv] } = await pool.query(
    `INSERT INTO user_invites (tenant_id, email, role, site_ids, token_hash, invited_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, expires_at`,
    [req.user.tenant_id, email, role, siteIds, sha256(token), req.user.id]);

  rbac.audit(req, 'user.invited', { targetType: 'email', targetId: email,
    detail: { role, siteIds } });

  const { rows: [t] } = await pool.query(
    'SELECT company FROM tenants WHERE id=$1', [req.user.tenant_id]);

  const mail = await mailer.send('user_invited', email, {
    url: `${process.env.CONSOLE_ORIGIN}/accept?token=${token}`,
    inviter: req.user.name || req.user.email,
    company: t?.company || 'their Algivo account',
    role
  }, { tenantId: req.user.tenant_id });

  // The link is still returned when delivery fails, so a mail outage never
  // blocks onboarding a colleague.
  res.json({ ok: true, inviteId: inv.id, expiresAt: inv.expires_at,
    emailed: mail.ok,
    inviteUrl: mail.ok ? undefined
      : `${process.env.CONSOLE_ORIGIN}/accept?token=${token}`,
    note: mail.ok ? 'Invite emailed.'
      : 'Email delivery failed — send this link directly.' });
});

/** Public: accept an invite and set a password. */
router.post('/invites/accept', async (req, res) => {
  const { token, password, name } = req.body || {};
  if (!token || !password || password.length < 10) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  const { rows: [inv] } = await pool.query(
    `SELECT * FROM user_invites
      WHERE token_hash=$1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()`, [sha256(token)]);
  if (!inv) return res.status(404).json({ ok: false, error: 'invalid_or_expired' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query(
      `INSERT INTO console_users (tenant_id, email, password_hash, role, name,
                                  status, email_verified)
       VALUES ($1,$2,crypt($3, gen_salt('bf')),$4,$5,'active',true) RETURNING id`,
      [inv.tenant_id, inv.email, password, inv.role, name || null]);

    for (const siteId of inv.site_ids || []) {
      await client.query(
        'INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [user.id, siteId]);
    }
    await client.query('UPDATE user_invites SET accepted_at=now() WHERE id=$1', [inv.id]);
    await client.query('COMMIT');

    res.json({ ok: true, token: rbac.issueToken(user.id) });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ ok: false, error: 'accept_failed' });
  } finally { client.release(); }
});

router.post('/users/:id/role', rbac.require('users:write'), async (req, res) => {
  const { role } = req.body || {};
  if (!rbac.PERMISSIONS[role]) return res.status(400).json({ ok: false });
  if (role === 'owner' && req.user.role !== 'owner') {
    return res.status(403).json({ ok: false, error: 'only_owner_can_grant_owner' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'cannot_change_own_role' });
  }

  try {
    // token_valid_from bump = the user's existing sessions stop working
    // immediately, rather than keeping old permissions until expiry.
    const { rowCount } = await pool.query(
      `UPDATE console_users SET role=$3::console_role, token_valid_from=now()
        WHERE id=$1 AND tenant_id=$2`,
      [req.params.id, req.user.tenant_id, role]);
    if (!rowCount) return res.status(404).json({ ok: false });
  } catch (e) {
    // The last-owner trigger raises here.
    return res.status(409).json({ ok: false, error: e.message });
  }

  rbac.audit(req, 'user.role_changed',
    { targetType: 'user', targetId: req.params.id, detail: { role } });
  res.json({ ok: true });
});

router.post('/users/:id/sites', rbac.require('users:write'), async (req, res) => {
  const { siteIds = [] } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM user_sites WHERE user_id=$1
        AND EXISTS (SELECT 1 FROM console_users u
                     WHERE u.id=$1 AND u.tenant_id=$2)`,
      [req.params.id, req.user.tenant_id]);
    for (const s of siteIds) {
      await client.query(
        'INSERT INTO user_sites (user_id, site_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.params.id, s]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ ok: false });
  } finally { client.release(); }

  rbac.audit(req, 'user.sites_changed',
    { targetType: 'user', targetId: req.params.id, detail: { siteIds } });
  res.json({ ok: true });
});

router.post('/users/:id/suspend', rbac.require('users:write'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'cannot_suspend_self' });
  }
  try {
    await pool.query(
      `UPDATE console_users SET status='suspended', token_valid_from=now()
        WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenant_id]);
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message });
  }
  rbac.audit(req, 'user.suspended', { targetType: 'user', targetId: req.params.id });
  res.json({ ok: true });
});

router.post('/users/:id/reactivate', rbac.require('users:write'), async (req, res) => {
  await pool.query(
    `UPDATE console_users SET status='active', failed_logins=0, locked_until=NULL
      WHERE id=$1 AND tenant_id=$2`, [req.params.id, req.user.tenant_id]);
  rbac.audit(req, 'user.reactivated', { targetType: 'user', targetId: req.params.id });
  res.json({ ok: true });
});

router.delete('/users/:id', rbac.require('users:write'), async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ ok: false, error: 'cannot_remove_self' });
  }
  try {
    await pool.query('DELETE FROM console_users WHERE id=$1 AND tenant_id=$2',
      [req.params.id, req.user.tenant_id]);
  } catch (e) {
    return res.status(409).json({ ok: false, error: e.message });
  }
  rbac.audit(req, 'user.removed', { targetType: 'user', targetId: req.params.id });
  res.json({ ok: true });
});

router.post('/users/invites/:id/revoke', rbac.require('users:write'), async (req, res) => {
  await pool.query(
    'UPDATE user_invites SET revoked_at=now() WHERE id=$1 AND tenant_id=$2',
    [req.params.id, req.user.tenant_id]);
  rbac.audit(req, 'invite.revoked', { targetType: 'invite', targetId: req.params.id });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */

router.get('/audit', rbac.require('audit:read'), async (req, res) => {
  const rows = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT actor_email, action, target_type, target_id, detail, ip, created_at
       FROM audit_log WHERE tenant_id=$1
      ORDER BY created_at DESC LIMIT 200`, [req.user.tenant_id]));
  res.json({ ok: true, entries: rows.rows });
});

module.exports = router;
