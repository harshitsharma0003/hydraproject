'use strict';

const { pool } = require('./db');

/**
 * Per-key, per-minute limit sitting in front of the monthly quota.
 *
 * Quota alone is monthly, so a runaway storefront loop could burn a customer's
 * entire allowance in minutes before anything noticed. This is the fast guard.
 *
 * Fails OPEN: if the rate table is unavailable, requests are allowed. A storefront
 * outage caused by our own rate limiter would be worse than the overage.
 */

const LIMITS = { starter: 300, growth: 1200, enterprise: 6000 };

function rateLimit(req, res, next) {
  const key = req.hydra;
  if (!key) return next();

  const limit = LIMITS[key.tier] || LIMITS.starter;

  pool.query('SELECT rate_check($1,$2) AS ok', [key.id, limit])
    .then(({ rows }) => {
      if (rows[0]?.ok === false) {
        res.set('Retry-After', '60');
        // 200 with ok:false, not 429: storefront clients treat any non-ok as
        // "fall back to native search", which is the behaviour we want.
        return res.status(200).json({ ok: false, error: 'rate_limited' });
      }
      next();
    })
    .catch(() => next());
}

module.exports = { rateLimit, LIMITS };
