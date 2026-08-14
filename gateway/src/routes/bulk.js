'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const { withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');

const router = express.Router();
const SFTP_ROOT = process.env.SFTP_ROOT || '/srv/algivo/sftp';

/**
 * Bulk ingest control plane. The bytes never come through here - they arrive
 * over SFTP. These endpoints only open a job, hand back a drop path, and let
 * the exporter report progress.
 *
 * RLS: ingest_jobs (and sites/embed_queue) are under FORCE ROW LEVEL SECURITY
 * with tenant_isolation (tenant_id = current_tenant()). Every query here MUST
 * run inside withTenant(tenantId) - a plain pool connection has no tenant
 * context, so reads return zero rows and writes are rejected by the policy.
 * That is why the SFTP full sync never created a job and the console Syncs page
 * (which reads ingest_jobs) stayed empty. Same class as the meter/embed bugs.
 */

/** Open a job and create its drop directory. */
router.post('/bulk/begin', versionGate, requireKey('secret'), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.algivo;
  const { mode = 'full', locale = 'en', expectedChunks = null } = req.body || {};

  const site = await withTenant(tenantId, (c) => c.query(
    'SELECT sftp_username, sftp_enabled FROM sites WHERE id = $1', [siteId]))
    .then((r) => r.rows[0]);
  if (!site?.sftp_enabled || !site.sftp_username) {
    return res.json({ ok: false, error: 'sftp_not_provisioned' });
  }

  // One open full sync at a time. Two concurrent full exports would race in
  // ingest_promote and could mark live products offline.
  const open = await withTenant(tenantId, (c) => c.query(
    `SELECT id FROM ingest_jobs
      WHERE site_id=$1 AND mode='full'
        AND state NOT IN ('complete','failed','aborted')`, [siteId]))
    .then((r) => r.rows);
  if (mode === 'full' && open.length) {
    return res.json({ ok: false, error: 'sync_already_running', jobId: open[0].id });
  }

  const job = await withTenant(tenantId, (c) => c.query(
    `INSERT INTO ingest_jobs (tenant_id, site_id, locale, mode, transport,
                              state, expected_chunks)
     VALUES ($1,$2,$3,$4,'sftp','open',$5) RETURNING id`,
    [tenantId, siteId, locale, mode, expectedChunks]))
    .then((r) => r.rows[0]);

  const dropPrefix = path.join(site.sftp_username, 'incoming', job.id);
  await fsp.mkdir(path.join(SFTP_ROOT, dropPrefix), { recursive: true });
  await withTenant(tenantId, (c) => c.query(
    'UPDATE ingest_jobs SET drop_prefix=$2 WHERE id=$1', [job.id, dropPrefix]));

  res.json({
    ok: true,
    jobId: job.id,
    // Path relative to the SFTP user's home.
    dropPath: `incoming/${job.id}`,
    chunkNameFormat: 'chunk-%05d.ndjson.gz',
    manifestName: 'manifest.json',
    maxRowsPerChunk: 20000,
    note: 'Write manifest.json LAST. Nothing is ingested until it appears.'
  });
});

/**
 * Optional progress ping. The worker does not need it - the manifest is the
 * real trigger - but it makes a half-finished export visible in the console.
 */
router.post('/bulk/progress', versionGate, requireKey('secret'), async (req, res) => {
  const tenantId = req.algivo.tenant_id;
  const { jobId, chunksWritten } = req.body || {};
  await withTenant(tenantId, (c) => c.query(
    `UPDATE ingest_jobs SET state='uploading', received_chunks=$2, updated_at=now()
      WHERE id=$1 AND tenant_id=$3 AND state IN ('open','uploading')`,
    [jobId, chunksWritten || 0, tenantId]));
  res.json({ ok: true });
});

router.get('/bulk/status/:jobId', versionGate, requireKey('secret'), async (req, res) => {
  const tenantId = req.algivo.tenant_id;
  const result = await withTenant(tenantId, async (c) => {
    const { rows: [job] } = await c.query(
      `SELECT id, mode, state, expected_chunks, received_chunks, rows_loaded,
              rows_promoted, rows_queued, error, created_at, completed_at
         FROM ingest_jobs WHERE id=$1 AND tenant_id=$2`,
      [req.params.jobId, tenantId]);
    if (!job) return null;
    const { rows: [q] } = await c.query(
      'SELECT count(*)::int AS remaining FROM embed_queue WHERE job_id=$1', [job.id]);
    return { job, remaining: q.remaining };
  });
  if (!result) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, job: result.job, embedRemaining: result.remaining });
});

router.post('/bulk/abort', versionGate, requireKey('secret'), async (req, res) => {
  const tenantId = req.algivo.tenant_id;
  await withTenant(tenantId, (c) => c.query(
    `UPDATE ingest_jobs SET state='aborted', updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('complete','failed')`,
    [req.body?.jobId, tenantId]));
  res.json({ ok: true });
});

/**
 * HTTP fallback for merchants who cannot use SFTP. Same NDJSON chunk format,
 * written to the same drop directory, ingested by the same worker.
 */
router.post('/bulk/chunk', versionGate, requireKey('secret'),
  express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
    const tenantId = req.algivo.tenant_id;
    const jobId = req.get('X-Algivo-Job');
    const seq = parseInt(req.get('X-Algivo-Seq') || '0', 10);
    const job = await withTenant(tenantId, (c) => c.query(
      'SELECT * FROM ingest_jobs WHERE id=$1 AND tenant_id=$2', [jobId, tenantId]))
      .then((r) => r.rows[0]);
    if (!job) return res.status(404).json({ ok: false });

    const name = `chunk-${String(seq).padStart(5, '0')}.ndjson.gz`;
    await fsp.writeFile(path.join(SFTP_ROOT, job.drop_prefix, name), req.body);
    await withTenant(tenantId, (c) => c.query(
      `UPDATE ingest_jobs SET received_chunks=received_chunks+1, state='uploading',
              updated_at=now() WHERE id=$1`, [jobId]));
    res.json({ ok: true, written: name });
  });

/** Finalises an HTTP upload by writing the manifest, which triggers the worker. */
router.post('/bulk/manifest', versionGate, requireKey('secret'), async (req, res) => {
  const tenantId = req.algivo.tenant_id;
  const { jobId, manifest } = req.body || {};
  const job = await withTenant(tenantId, (c) => c.query(
    'SELECT * FROM ingest_jobs WHERE id=$1 AND tenant_id=$2', [jobId, tenantId]))
    .then((r) => r.rows[0]);
  if (!job) return res.status(404).json({ ok: false });

  await fsp.writeFile(
    path.join(SFTP_ROOT, job.drop_prefix, 'manifest.json'),
    JSON.stringify(manifest, null, 2));
  await withTenant(tenantId, (c) => c.query(
    `UPDATE ingest_jobs SET state='manifest_received', manifest=$2, updated_at=now()
      WHERE id=$1`, [jobId, manifest]));
  res.json({ ok: true });
});

module.exports = router;
