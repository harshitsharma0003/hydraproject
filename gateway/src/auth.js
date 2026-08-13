'use strict';

const crypto = require('crypto');
const { pool } = require('./db');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

/**
 * Two key kinds.
 *   publishable - origin-locked, browser-safe, read paths only
 *   secret      - server-to-server, required for sync/discover/admin
 *
 * Shipping one key is how integrations leak. The split is enforced here.
 */
function requireKey(kind) {
  return async function (req, res, next) {
    const raw = req.get('X-Algivo-Key');
    if (!raw) return res.status(401).json({ ok: false, error: 'missing_key' });

    const { rows } = await pool.query(
      `SELECT k.id, k.tenant_id, k.site_id, k.kind, l.status, l.tier,
              l.narration_enabled, l.overage_allowed,
              s.environment,
              -- Non-production runs against its own cap, so a merchant's QA
              -- suite can never eat production allowance or reach the invoice.
              CASE WHEN s.environment = 'production'
                   THEN l.monthly_query_quota
                   ELSE l.nonprod_monthly_query_cap END AS monthly_query_quota,
              (s.environment = 'production') AS billable
         FROM api_keys k
         JOIN licenses l ON l.tenant_id = k.tenant_id
         JOIN sites s    ON s.id = k.site_id
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL
        LIMIT 1`, [sha256(raw)]);

    const key = rows[0];
    if (!key) return res.status(401).json({ ok: false, error: 'invalid_key' });
    if (kind && key.kind !== kind) {
      return res.status(403).json({ ok: false, error: 'wrong_key_kind' });
    }
    if (key.status === 'suspended' || key.status === 'cancelled') {
      // Soft-fail: the storefront degrades to native search rather than erroring.
      return res.status(402).json({ ok: false, error: 'license_inactive' });
    }

    // Origin lock applies to publishable keys only.
    if (key.kind === 'publishable') {
      const origin = req.get('Origin');
      if (origin) {
        const { rows: sites } = await pool.query(
          'SELECT allowed_origins FROM sites WHERE id = $1', [key.site_id]);
        const allowed = sites[0]?.allowed_origins || [];
        if (allowed.length && !allowed.includes(origin)) {
          return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
        }
      }
    }

    req.algivo = key;
    pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id])
      .catch(() => {});
    next();
  };
}

/**
 * Contract version gate. Versioning at /v1/ means a gateway deploy can never
 * break a cartridge in the field. Cartridges get a full release cycle of soft
 * deprecation warnings before anything hard-fails.
 */
function versionGate(req, res, next) {
  const v = req.get('X-Algivo-Version') || '0.0.0';
  const [major] = v.split('.').map(Number);
  if (major < 1) {
    return res.status(426).json({ ok: false, error: 'cartridge_too_old', minimum: '1.0.0' });
  }
  if (v === '1.0.0') res.set('X-Algivo-Deprecation', 'none');
  next();
}

function issueKey(kind) {
  const prefix = kind === 'secret' ? 'alg_sk_' : 'alg_pk_';
  const body = crypto.randomBytes(24).toString('base64url');
  const full = prefix + body;
  return { full, prefix, hash: sha256(full) };
}

module.exports = { requireKey, versionGate, issueKey, sha256 };
