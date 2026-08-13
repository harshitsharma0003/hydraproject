'use strict';

/**
 * Applies db/migrations/*.sql in filename order, tracking what has run.
 * Idempotent - safe to run on every deploy.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DIR = path.join(__dirname, '..', '..', 'db', 'migrations');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS hydra;
    CREATE TABLE IF NOT EXISTS hydra.schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT filename FROM hydra.schema_migrations');
  const done = new Set(rows.map((r) => r.filename));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  for (const f of files) {
    if (done.has(f)) { console.log('skip', f); continue; }
    console.log('apply', f);
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO hydra.schema_migrations (filename) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('  ok');
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('  FAILED:', e.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log('migrations complete');
})();
