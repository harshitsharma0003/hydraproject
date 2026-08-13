'use strict';

const express = require('express');
const fsp = require('fs/promises');
const path = require('path');
const { pool } = require('../db');
const { requireKey, versionGate } = require('../auth');

const router = express.Router();
const SFTP_ROOT = process.env.SFTP_ROOT || '/srv/algivo/sftp';

/**
 * Bulk ingest control plane. The bytes never come through here - they arrive
 * over SFTP. These endpoints only open a job, hand back a drop path, and let
 * the exporter report progress.
 */

/** Open a job and create its drop directory. */
router.post('/bulk/begin', versionGate, requireKey('secret'), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.algivo;
  const { mode = 'full', locale = 'en', expectedChunks = null } = req.body || {};

  const { rows: [site] } = await pool.query(
    'SELECT sftp_username, sftp_enabled FROM sites WHERE id = $1', [siteId]);
  if (!site?.sftp_enabled || !site.sftp_username) {
    return res.json({ ok: false, error: 'sftp_not_provisioned' });
  }

  // One open full sync at a time. Two concurrent full exports would race in
  // ingest_promote and could mark live products offline.
  const { rows: open } = await pool.query(
    `SELECT id FROM ingest_jobs
      WHERE site_id=$1 AND mode='full'
        AND state NOT IN ('complete','failed','aborted')`, [siteId]);
  if (mode === 'full' && open.length) {
    return res.json({ ok: false, error: 'sync_already_running', jobId: open[0].id });
  }

  const { rows: [job] } = await pool.query(
    `INSERT INTO ingest_jobs (tenant_id, site_id, locale, mode, transport,
                              state, expected_chunks)
     VALUES ($1,$2,$3,$4,'sftp','open',$5) RETURNING id`,
    [tenantId, siteId, locale, mode, expectedChunks]);

  const dropPrefix = path.join(site.sftp_username, 'incoming', job.id);
  await fsp.mkdir(path.join(SFTP_ROOT, dropPrefix), { recursive: true });
  await pool.query('UPDATE ingest_jobs SET drop_prefix=$2 WHERE id=$1',
    [job.id, dropPrefix]);

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
  const { jobId, chunksWritten } = req.body || {};
  await pool.query(
    `UPDATE ingest_jobs SET state='uploading', received_chunks=$2, updated_at=now()
      WHERE id=$1 AND tenant_id=$3 AND state IN ('open','uploading')`,
    [jobId, chunksWritten || 0, req.algivo.tenant_id]);
  res.json({ ok: true });
});

router.get('/bulk/status/:jobId', versionGate, requireKey('secret'), async (req, res) => {
  const { rows: [job] } = await pool.query(
    `SELECT id, mode, state, expected_chunks, received_chunks, rows_loaded,
            rows_promoted, rows_queued, error, created_at, completed_at
       FROM ingest_jobs WHERE id=$1 AND tenant_id=$2`,
    [req.params.jobId, req.algivo.tenant_id]);
  if (!job) return res.status(404).json({ ok: false, error: 'not_found' });

  const { rows: [q] } = await pool.query(
    'SELECT count(*)::int AS remaining FROM embed_queue WHERE job_id=$1', [job.id]);

  res.json({ ok: true, job, embedRemaining: q.remaining });
});

router.post('/bulk/abort', versionGate, requireKey('secret'), async (req, res) => {
  await pool.query(
    `UPDATE ingest_jobs SET state='aborted', updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND state NOT IN ('complete','failed')`,
    [req.body?.jobId, req.algivo.tenant_id]);
  res.json({ ok: true });
});

/**
 * HTTP fallback for merchants who cannot use SFTP. Same NDJSON chunk format,
 * written to the same drop directory, ingested by the same worker.
 */
router.post('/bulk/chunk', versionGate, requireKey('secret'),
  express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
    const jobId = req.get('X-Algivo-Job');
    const seq = parseInt(req.get('X-Algivo-Seq') || '0', 10);
    const { rows: [job] } = await pool.query(
      'SELECT * FROM ingest_jobs WHERE id=$1 AND tenant_id=$2',
      [jobId, req.algivo.tenant_id]);
    if (!job) return res.status(404).json({ ok: false });

    const name = `chunk-${String(seq).padStart(5, '0')}.ndjson.gz`;
    await fsp.writeFile(path.join(SFTP_ROOT, job.drop_prefix, name), req.body);
    await pool.query(
      `UPDATE ingest_jobs SET received_chunks=received_chunks+1, state='uploading',
              updated_at=now() WHERE id=$1`, [jobId]);
    res.json({ ok: true, written: name });
  });

/** Finalises an HTTP upload by writing the manifest, which triggers the worker. */
router.post('/bulk/manifest', versionGate, requireKey('secret'), async (req, res) => {
  const { jobId, manifest } = req.body || {};
  const { rows: [job] } = await pool.query(
    'SELECT * FROM ingest_jobs WHERE id=$1 AND tenant_id=$2',
    [jobId, req.algivo.tenant_id]);
  if (!job) return res.status(404).json({ ok: false });

  await fsp.writeFile(
    path.join(SFTP_ROOT, job.drop_prefix, 'manifest.json'),
    JSON.stringify(manifest, null, 2));
  await pool.query(
    `UPDATE ingest_jobs SET state='manifest_received', manifest=$2, updated_at=now()
      WHERE id=$1`, [jobId, manifest]);
  res.json({ ok: true });
});

module.exports = router;
