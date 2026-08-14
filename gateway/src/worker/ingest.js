'use strict';

/**
 * Ingest worker.
 *
 * Watches the SFTP drop root for completed jobs and loads them into staging,
 * then promotes. Runs on the same VM as the SFTP server, so it reads from local
 * disk - no network transfer, no credentials, no second copy of the catalog.
 *
 * A job is only considered complete when its manifest file is present AND every
 * chunk it names exists with a matching row count. That is what makes a partial
 * upload safe: without the manifest nothing is loaded, so an interrupted
 * transfer leaves the live index untouched.
 *
 * Directory layout under SFTP_ROOT:
 *   <sftp_username>/incoming/<jobId>/chunk-00001.ndjson.gz
 *   <sftp_username>/incoming/<jobId>/manifest.json     <- written LAST
 *   <sftp_username>/processed/<jobId>/                 <- moved here after load
 *   <sftp_username>/failed/<jobId>/                    <- kept for inspection
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const copyFrom = require('pg-copy-streams').from;

const { pool, withTenant } = require('../db');
const mailer = require('../mailer');

const SFTP_ROOT = process.env.SFTP_ROOT || '/srv/algivo/sftp';
const POLL_MS = parseInt(process.env.INGEST_POLL_MS || '15000', 10);
const WORKER_ID = `${require('os').hostname()}-ingest-${process.pid}`;

async function findReadyJobs() {
  const out = [];
  let users;
  try { users = await fsp.readdir(SFTP_ROOT, { withFileTypes: true }); }
  catch (e) { return out; }

  for (const u of users) {
    if (!u.isDirectory()) continue;
    const incoming = path.join(SFTP_ROOT, u.name, 'incoming');
    let jobs;
    try { jobs = await fsp.readdir(incoming, { withFileTypes: true }); }
    catch (e) { continue; }

    for (const j of jobs) {
      if (!j.isDirectory()) continue;
      const dir = path.join(incoming, j.name);
      // The manifest is written last by the exporter. Its absence means the
      // upload is still in flight - leave it alone.
      if (!fs.existsSync(path.join(dir, 'manifest.json'))) continue;
      out.push({ sftpUser: u.name, jobId: j.name, dir });
    }
  }
  return out;
}

async function sha256File(p) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(p), hash);
  return hash.digest('hex');
}

/**
 * Streams one gzipped NDJSON chunk into products_staging via COPY.
 * Never buffers the whole file - a 200k-master export is streamed line by line.
 */
async function loadChunk(client, job, chunkPath) {
  const stream = client.query(copyFrom(
    `COPY products_staging (job_id, tenant_id, site_id, master_id, locale, title,
       description, brand, handle, category_path, attrs, colors, sizes,
       variant_count, list_price, currency, online, in_stock_hint, content_hash)
     FROM STDIN WITH (FORMAT csv, NULL '\\N')`));

  const rl = readline.createInterface({
    input: fs.createReadStream(chunkPath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  });

  let rows = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    stream.write(toCsv(job, r) + '\n');
    rows++;
    if (stream.writableLength > 1 << 20) {
      await new Promise((res) => stream.once('drain', res));
    }
  }
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); stream.end(); });
  return rows;
}

const q = (v) => v === null || v === undefined ? '\\N'
  : '"' + String(v).replace(/"/g, '""') + '"';
const arr = (a) => !a || !a.length ? '\\N'
  : '"{' + a.map((x) => '""' + String(x).replace(/"/g, '""""') + '""').join(',') + '}"';

function toCsv(job, r) {
  return [
    q(job.id), q(job.tenant_id), q(job.site_id),
    q(r.masterId), q(r.locale || job.locale),
    q(r.title), q(r.description || ''), q(r.brand), q(r.handle),
    arr(r.categoryPath), q(JSON.stringify(r.attrs || {})),
    arr(r.colors), arr(r.sizes),
    r.variantCount || 1,
    r.listPrice === null || r.listPrice === undefined ? '\\N' : r.listPrice,
    q(r.currency), r.online !== false, r.inStockHint !== false,
    q(r.contentHash)
  ].join(',');
}

async function processJob({ sftpUser, jobId, dir }) {
  // ingest_jobs is RLS-scoped and the worker has no tenant context yet (it
  // found the job on disk, not via the DB). Load it through the SECURITY
  // DEFINER loader (migration 0011) which bypasses RLS; job.tenant_id then
  // scopes every write below.
  const { rows: [job] } = await pool.query(
    'SELECT * FROM ingest_job_load($1)', [jobId]);
  if (!job) { console.warn('[ingest] unknown job', jobId); return; }
  if (['complete', 'failed', 'aborted'].includes(job.state)) return;

  const manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));

  await withTenant(job.tenant_id, (c) => c.query(
    `UPDATE ingest_jobs SET state='loading', manifest=$2, expected_chunks=$3,
            updated_at=now() WHERE id=$1`,
    [jobId, manifest, manifest.chunks.length]));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1,$2,true)', ['algivo.tenant_id', job.tenant_id]);

    let total = 0;
    for (const c of manifest.chunks) {
      const p = path.join(dir, c.filename);
      if (!fs.existsSync(p)) throw new Error(`missing chunk ${c.filename}`);

      // Checksum before parsing. A truncated transfer must never be promoted.
      if (c.sha256) {
        const actual = await sha256File(p);
        if (actual !== c.sha256) throw new Error(`checksum mismatch ${c.filename}`);
      }

      const rows = await loadChunk(client, job, p);
      if (c.rowCount && rows !== c.rowCount) {
        throw new Error(`row count mismatch ${c.filename}: got ${rows}, expected ${c.rowCount}`);
      }
      total += rows;

      await client.query(
        `INSERT INTO ingest_chunks (job_id, seq, filename, row_count, sha256, state, loaded_at)
         VALUES ($1,$2,$3,$4,$5,'loaded',now())
         ON CONFLICT (job_id, seq) DO UPDATE SET state='loaded', loaded_at=now()`,
        [jobId, c.seq, c.filename, rows, c.sha256 || null]);
    }

    if (manifest.totalRows && total !== manifest.totalRows) {
      throw new Error(`total row mismatch: loaded ${total}, manifest says ${manifest.totalRows}`);
    }

    await client.query(
      `UPDATE ingest_jobs SET state='promoting', rows_loaded=$2, updated_at=now()
        WHERE id=$1`, [jobId, total]);

    await client.query('SELECT set_config($1,$2,true)',
      ['algivo.embed_model', process.env.EMBEDDING_MODEL || 'voyage-3']);
    const { rows: [res] } = await client.query('SELECT * FROM ingest_promote($1)', [jobId]);

    await client.query(
      `UPDATE ingest_jobs SET state = CASE WHEN $3::bigint > 0 THEN 'embedding'::ingest_state
                                           ELSE 'complete'::ingest_state END,
              rows_promoted=$2, rows_queued=$3,
              completed_at = CASE WHEN $3::bigint > 0 THEN NULL ELSE now() END,
              updated_at=now()
        WHERE id=$1`, [jobId, res.promoted, res.queued]);

    await client.query('COMMIT');
    console.log(`[ingest] job ${jobId}: ${total} rows, ${res.promoted} promoted, ${res.queued} queued for embedding`);

    await move(dir, path.join(SFTP_ROOT, sftpUser, 'processed', jobId));
  } catch (e) {
    await client.query('ROLLBACK');
    await withTenant(job.tenant_id, (c) => c.query(
      `UPDATE ingest_jobs SET state='failed', error=$2, updated_at=now() WHERE id=$1`,
      [jobId, e.message]));
    console.error(`[ingest] job ${jobId} FAILED:`, e.message);

    // A silent sync failure means stale results with nobody aware. Tell them.
    try {
      const { rows: [ctx] } = await withTenant(job.tenant_id, (c) => c.query(
        `SELECT t.contact_email, s.external_site_id
           FROM sites s JOIN tenants t ON t.id = s.tenant_id
          WHERE s.id = $1`, [job.site_id]));
      if (ctx?.contact_email) {
        await mailer.send('sync_failed', ctx.contact_email,
          { site: ctx.external_site_id, error: e.message },
          { tenantId: job.tenant_id });
      }
    } catch (mailErr) { /* never let alerting break error handling */ }
    // Kept on disk so the merchant's export can be inspected rather than lost.
    await move(dir, path.join(SFTP_ROOT, sftpUser, 'failed', jobId)).catch(() => {});
  } finally {
    client.release();
  }
}

async function move(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

async function tick() {
  const jobs = await findReadyJobs();
  for (const j of jobs) {
    try { await processJob(j); }
    catch (e) { console.error('[ingest] unhandled', j.jobId, e.message); }
  }
}

if (require.main === module) {
  console.log(`[ingest] ${WORKER_ID} watching ${SFTP_ROOT} every ${POLL_MS}ms`);
  (async function loop() {
    for (;;) {
      try { await tick(); } catch (e) { console.error('[ingest]', e.message); }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }());
}

module.exports = { tick, processJob, findReadyJobs };
