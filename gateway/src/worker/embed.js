'use strict';

/**
 * Embedding worker.
 *
 * The whole reason ingest is fast now: embedding happens here, out of band,
 * instead of inside the sync request. Several instances can run concurrently -
 * embed_claim() uses SKIP LOCKED so they never fight over the same rows and
 * need no coordinator.
 *
 * Products stay searchable throughout. ingest_promote() deliberately does not
 * clear the old embedding, so a resync never blanks the index mid-flight; rows
 * are swapped one batch at a time.
 */

const { pool, withTenant } = require('../db');
const { embed, toPgVector, MODEL } = require('../embeddings');

const BATCH = parseInt(process.env.EMBED_BATCH || '128', 10);
const IDLE_MS = parseInt(process.env.EMBED_IDLE_MS || '5000', 10);
const WORKER_ID = `${require('os').hostname()}-embed-${process.pid}`;

async function tick() {
  const { rows: batch } = await pool.query('SELECT * FROM embed_claim($1,$2)',
    [WORKER_ID, BATCH]);
  if (!batch.length) return 0;

  let vectors;
  try {
    vectors = await embed(batch.map((r) => r.text_to_embed), 'document');
  } catch (e) {
    // Release for retry. embed_queue is RLS-scoped and a batch can span
    // tenants, so group by tenant and update each in its own context - a plain
    // pool update here has no tenant context and is rejected by the policy.
    const byTenant = new Map();
    for (const r of batch) {
      if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
      byTenant.get(r.tenant_id).push(r.id);
    }
    for (const [tenantId, ids] of byTenant) {
      await withTenant(tenantId, (c) => c.query(
        `UPDATE embed_queue SET error=$2, claimed_at=NULL WHERE id = ANY($1)`,
        [ids, e.message])).catch(() => {});
    }
    console.error('[embed] provider failed:', e.message);
    return 0;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < batch.length; i++) {
      const r = batch[i];
      await client.query('SELECT set_config($1,$2,true)', ['algivo.tenant_id', r.tenant_id]);
      await client.query(
        `UPDATE products
            SET embedding = $5::halfvec, embed_model = $6, embedded_at = now()
          WHERE tenant_id=$1 AND site_id=$2 AND master_id=$3 AND locale=$4`,
        [r.tenant_id, r.site_id, r.master_id, r.locale, toPgVector(vectors[i]), MODEL]);
    }
    await client.query('DELETE FROM embed_queue WHERE id = ANY($1)',
      [batch.map((r) => r.id)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[embed] write failed:', e.message);
    return 0;
  } finally {
    client.release();
  }

  await closeFinishedJobs(batch);
  return batch.length;
}

/** Flip a job to complete once nothing is left queued for it. */
async function closeFinishedJobs(batch) {
  // ingest_jobs is RLS-scoped and a batch can span tenants, so group job ids by
  // tenant and flip each in its own context. A plain pool update here has no
  // tenant context and is rejected by the policy - which left SFTP full syncs
  // stuck at 'embedding' forever instead of reaching 'complete'.
  const byTenant = new Map();
  for (const r of batch) {
    if (!r.job_id) continue;
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, new Set());
    byTenant.get(r.tenant_id).add(r.job_id);
  }
  for (const [tenantId, ids] of byTenant) {
    await withTenant(tenantId, (c) => c.query(
      `UPDATE ingest_jobs j SET state='complete', completed_at=now(), updated_at=now()
        WHERE j.id = ANY($1) AND j.state='embedding'
          AND NOT EXISTS (SELECT 1 FROM embed_queue q WHERE q.job_id = j.id)`,
      [[...ids]]));
  }
}

if (require.main === module) {
  console.log(`[embed] ${WORKER_ID} started, batch=${BATCH}`);
  (async function loop() {
    for (;;) {
      let n = 0;
      try { n = await tick(); } catch (e) { console.error('[embed]', e.message); }
      if (!n) await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }());
}

module.exports = { tick };
