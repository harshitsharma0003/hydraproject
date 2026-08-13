'use strict';

const jwt = require('jsonwebtoken');
const { pool } = require('./db');

/**
 * Permission matrix.
 *
 * Deliberately explicit rather than hierarchical. "developer inherits viewer"
 * reads well until someone adds a permission to viewer and silently grants it
 * to everyone, so each role lists exactly what it can do.
 */
const PERMISSIONS = {
  owner: [
    'billing:read', 'billing:write', 'users:read', 'users:write',
    'keys:read', 'keys:rotate', 'sites:read', 'sites:write',
    'rules:read', 'rules:write', 'sync:read', 'sync:write',
    'queries:read', 'cache:flush', 'audit:read', 'tenant:delete'
  ],
  admin: [
    'billing:read', 'users:read', 'users:write',
    'keys:read', 'keys:rotate', 'sites:read', 'sites:write',
    'rules:read', 'rules:write', 'sync:read', 'sync:write',
    'queries:read', 'cache:flush', 'audit:read'
  ],
  developer: [
    'keys:read', 'keys:rotate', 'sites:read',
    'sync:read', 'sync:write', 'queries:read', 'cache:flush'
  ],
  merchandiser: [
    'sites:read', 'rules:read', 'rules:write', 'queries:read',
    'sync:read', 'cache:flush'
  ],
  viewer: [
    'sites:read', 'rules:read', 'queries:read', 'sync:read', 'billing:read'
  ]
};

const ROLE_LABELS = {
  owner: 'Owner — full access including billing and account deletion',
  admin: 'Admin — everything except billing changes and deleting the account',
  developer: 'Developer — keys, syncs and environments for assigned sites',
  merchandiser: 'Merchandiser — rules, cache and query reports for assigned sites',
  viewer: 'Viewer — read only'
};

/** Roles whose access is limited to explicitly assigned sites. */
const SCOPED_ROLES = new Set(['developer', 'merchandiser', 'viewer']);

/**
 * Authenticate.
 *
 * The token carries only the user id. Role, status and tenant are loaded from
 * the database on every request, so demoting or suspending someone takes effect
 * on their next call rather than whenever their token happens to expire.
 */
async function authenticate(req, res, next) {
  const header = req.get('Authorization') || '';
  const raw = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!raw) return res.status(401).json({ ok: false, error: 'no_token' });

  let claims;
  try { claims = jwt.verify(raw, process.env.JWT_SECRET); }
  catch (e) { return res.status(401).json({ ok: false, error: 'bad_token' }); }

  const { rows } = await pool.query(
    `SELECT id, tenant_id, email, name, role, status, token_valid_from
       FROM console_users WHERE id = $1`, [claims.sub]);
  const user = rows[0];

  if (!user) return res.status(401).json({ ok: false, error: 'no_user' });
  if (user.status !== 'active') {
    return res.status(403).json({ ok: false, error: 'account_' + user.status });
  }
  // Password change, role change or suspension bumps token_valid_from, which
  // invalidates every token issued before it without needing a session store.
  if (claims.iat * 1000 < new Date(user.token_valid_from).getTime()) {
    return res.status(401).json({ ok: false, error: 'token_superseded' });
  }

  req.user = user;
  pool.query('UPDATE console_users SET last_seen_at = now() WHERE id = $1', [user.id])
    .catch(() => {});
  next();
}

function can(user, permission) {
  return (PERMISSIONS[user.role] || []).includes(permission);
}

function require_(permission) {
  return function (req, res, next) {
    if (!req.user) return res.status(401).json({ ok: false });
    if (!can(req.user, permission)) {
      return res.status(403).json({ ok: false, error: 'forbidden', need: permission });
    }
    next();
  };
}

/**
 * Site-level check for scoped roles. Call with the site id from the request
 * body or params. Owners and admins always pass.
 */
async function requireSite(req, res, next) {
  const siteId = req.body?.siteId || req.params?.siteId || req.query?.siteId;
  if (!siteId) return next();
  if (!SCOPED_ROLES.has(req.user.role)) return next();

  const { rows } = await pool.query(
    'SELECT user_can_access_site($1,$2) AS ok', [req.user.id, siteId]);
  if (!rows[0]?.ok) {
    return res.status(403).json({ ok: false, error: 'site_not_in_scope' });
  }
  next();
}

/**
 * Audit. Fire-and-forget so a logging failure never blocks the action, but
 * every state change calls it. Append-only: algivo_app has no UPDATE or DELETE
 * grant on this table.
 */
function audit(req, action, extra = {}) {
  const u = req.user || {};
  pool.query(
    `INSERT INTO audit_log (tenant_id, actor_id, actor_email, action, target_type,
                            target_id, site_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [u.tenant_id || extra.tenantId, u.id || null, u.email || extra.email || null,
     action, extra.targetType || null, extra.targetId || null,
     extra.siteId || null, JSON.stringify(extra.detail || {}),
     req.ip || null, (req.get('User-Agent') || '').slice(0, 300)]
  ).catch(() => {});
}

function issueToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '12h' });
}

module.exports = {
  PERMISSIONS, ROLE_LABELS, SCOPED_ROLES,
  authenticate, can, require: require_, requireSite, audit, issueToken
};
