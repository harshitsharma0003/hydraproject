'use strict';

const express = require('express');
const crypto = require('crypto');
const { pool, withTenant } = require('../db');
const rbac = require('../rbac');
const mailer = require('../mailer');
const rid = require('../requestid');

const router = express.Router();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * Request a reset.
 *
 * Always returns ok, whatever happens. Distinguishing "no such account" from
 * "email sent" turns this endpoint into a way to test which addresses are
 * registered, which is exactly what the login form already refuses to do.
 */
router.post('/auth/forgot', async (req, res) => {
  const { email } = req.body || {};
  const generic = { ok: true,
    message: 'If that address has an account, a reset link is on its way.' };

  if (!email) return res.json(generic);

  const { rows: [user] } = await pool.query(
    `SELECT u.id, u.email, u.name, u.status, t.company
       FROM console_users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1`, [email]);

  if (!user || user.status === 'suspended') {
    rid.info('reset.requested_unknown', { email });
    return res.json(generic);
  }

  const { rows: [allowed] } = await pool.query(
    'SELECT reset_allowed($1) AS ok', [user.id]);
  if (!allowed.ok) {
    // Silently rate limited. Telling them would confirm the account exists.
    rid.warn('reset.rate_limited', { userId: user.id });
    return res.json(generic);
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO password_resets (user_id, token_hash, requested_ip)
     VALUES ($1,$2,$3)`, [user.id, sha256(token), req.ip || null]);

  await mailer.send('password_reset', user.email, {
    name: user.name,
    url: `${process.env.CONSOLE_ORIGIN}/reset?token=${token}`
  });

  res.json(generic);
});

/** Check a token before showing the form, so an expired link fails early. */
router.get('/auth/reset/check', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT 1 FROM password_resets
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`,
    [sha256(String(req.query.token || ''))]);
  res.json({ ok: rows.length > 0 });
});

router.post('/auth/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || password.length < 10) {
    return res.status(400).json({ ok: false, error: 'weak_password',
      message: 'Use at least 10 characters.' });
  }

  const { rows: [pr] } = await pool.query(
    `SELECT pr.id, pr.user_id, u.email, u.name, u.tenant_id
       FROM password_resets pr JOIN console_users u ON u.id = pr.user_id
      WHERE pr.token_hash=$1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
    [sha256(token)]);

  if (!pr) {
    return res.status(400).json({ ok: false, error: 'invalid_or_expired',
      message: 'That link has expired or was already used.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // token_valid_from bump signs out every other session. A password reset
    // that leaves an attacker's session alive achieves nothing.
    await client.query(
      `UPDATE console_users
          SET password_hash = crypt($2, gen_salt('bf')),
              token_valid_from = now(), failed_logins = 0, locked_until = NULL
        WHERE id = $1`, [pr.user_id, password]);
    await client.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [pr.id]);
    // Invalidate any other outstanding reset links for this user.
    await client.query(
      `UPDATE password_resets SET used_at=now()
        WHERE user_id=$1 AND used_at IS NULL`, [pr.user_id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ ok: false, error: 'reset_failed' });
  } finally { client.release(); }

  // audit_log is RLS-scoped; write under the tenant's context or the policy
  // silently drops it (see rbac.audit).
  await withTenant(pr.tenant_id, (c) => c.query(
    `INSERT INTO audit_log (tenant_id, actor_id, actor_email, action, ip, user_agent)
     VALUES ($1,$2,$3,'user.password_reset',$4,$5)`,
    [pr.tenant_id, pr.user_id, pr.email, req.ip || null,
     (req.get('User-Agent') || '').slice(0, 300)]));

  // Security notice. If the reset wasn't them, this is how they find out.
  await mailer.send('password_changed', pr.email,
    { name: pr.name, ip: req.ip }, { tenantId: pr.tenant_id });

  res.json({ ok: true, token: rbac.issueToken(pr.user_id) });
});

/** Signed-in change, requires the current password. */
router.post('/auth/change-password', rbac.authenticate, async (req, res) => {
  const { current, password } = req.body || {};
  if (!password || password.length < 10) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  const { rows: [ok] } = await pool.query(
    `SELECT password_hash = crypt($2, password_hash) AS valid
       FROM console_users WHERE id=$1`, [req.user.id, current || '']);
  if (!ok?.valid) return res.status(403).json({ ok: false, error: 'wrong_password' });

  await pool.query(
    `UPDATE console_users SET password_hash = crypt($2, gen_salt('bf')),
            token_valid_from = now() WHERE id = $1`, [req.user.id, password]);

  rbac.audit(req, 'user.password_changed');
  await mailer.send('password_changed', req.user.email,
    { name: req.user.name, ip: req.ip }, { tenantId: req.user.tenant_id });

  res.json({ ok: true, token: rbac.issueToken(req.user.id) });
});

/** Provider bounce and complaint webhooks feed the suppression list. */
router.post('/email/webhook', express.json(), async (req, res) => {
  const b = req.body || {};
  const email = b.email || b.Recipient || b.recipient
             || b?.data?.to?.[0] || (b[0] && b[0].email);
  const type = String(b.RecordType || b.type || b.event || '').toLowerCase();

  if (email && /bounce|complaint|spam|dropped/.test(type)) {
    await pool.query(
      `INSERT INTO email_suppressions (email, reason)
       VALUES ($1, $2) ON CONFLICT (email) DO NOTHING`,
      [email, /complaint|spam/.test(type) ? 'complaint' : 'bounce']);
    rid.warn('email.suppressed_by_webhook', { email, type });
  }
  res.json({ received: true });
});

module.exports = router;
