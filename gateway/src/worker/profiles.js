'use strict';

/**
 * Visitor profile worker.
 *
 * Rebuilds style vectors from on-site behaviour. Runs on a schedule rather than
 * per request: a profile changes slowly, and recomputing it inside the query
 * path would add latency to every search to serve a signal that moves once a
 * day.
 *
 * No third-party data is involved. Instagram's Basic Display API was shut down
 * in December 2024 with no successor for personal accounts, and Google and
 * Facebook sign-in return an email address rather than interests. What people
 * click on your own site is a better signal anyway.
 */

const { pool } = require('../db');
const rid = require('../requestid');

const INTERVAL_MS = parseInt(process.env.PROFILE_INTERVAL_MS || '300000', 10);
const BATCH = parseInt(process.env.PROFILE_BATCH || '500', 10);

async function tick() {
  const { rows } = await pool.query('SELECT * FROM profiles_needing_refresh($1)', [BATCH]);
  if (!rows.length) return 0;

  let done = 0;
  for (const r of rows) {
    try {
      await pool.query('SELECT compute_visitor_profile($1,$2)',
        [r.tenant_id, r.visitor_id]);
      done++;
    } catch (e) {
      // One bad visitor must not stall the queue.
      rid.error('profile.failed', { visitor: r.visitor_id, error: e.message });
    }
  }
  rid.info('profiles.computed', { count: done });
  return done;
}

if (require.main === module) {
  rid.info('profiles.started', { intervalMs: INTERVAL_MS, batch: BATCH });
  (async function loop() {
    for (;;) {
      try { await tick(); } catch (e) { rid.error('profiles.tick', { error: e.message }); }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }());
}

module.exports = { tick };
