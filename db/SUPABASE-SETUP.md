# Database setup

> **Self-hosting on your own VM is now the primary path** — run
> `setup/install.sh`, which installs and tunes PostgreSQL 16 + pgvector, creates
> the `hydra_app` role, and applies migrations. The document below covers
> managed Postgres (Supabase or equivalent) if you separate the database from
> the app tier later.

---


Supabase is Postgres with pgvector already available, which is why it is the
fastest path here. Any managed Postgres 16+ with pgvector works identically.

---

## 1. Create the project

Region matters for latency. If your first design partner is in India, use
`ap-south-1` (Mumbai). Every query does a round trip to this database, so
co-locate it with the gateway.

Start on a plan with at least 4 GB RAM. The constraint is **not disk** — it is
whether the HNSW index stays resident in memory. Once it falls to disk, lookups
go from ~5 ms to 200 ms+.

Rule of thumb: about 500 MB of index per tenant at 50k masters. Provision RAM
against total index size across all tenants.

---

## 2. Enable extensions

In the SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Confirm pgvector is 0.7.0 or newer — `halfvec` does not exist before that:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

---

## 3. Run the migration

```bash
psql "$DATABASE_URL" -f db/migrations/0001_init.sql
```

---

## 4. Connection string

Use the **session pooler** (port 5432), not the transaction pooler (6543).

`SET LOCAL hydra.tenant_id` — which is how row-level security isolates tenants —
requires session-level state that the transaction pooler does not preserve.
Getting this wrong causes intermittent, extremely confusing cross-tenant
behaviour under load.

```
postgresql://postgres.PROJECT:PASSWORD@aws-0-REGION.pooler.supabase.com:5432/postgres
```

---

## 5. Row-level security

The migration enables `FORCE ROW LEVEL SECURITY` on every tenant-scoped table.
The gateway sets `hydra.tenant_id` inside a transaction before touching them.

**Do not connect the gateway as the table owner or as `postgres`.** Owners
bypass RLS unless forced, and you lose the guarantee that makes the security
data sheet true. Create a dedicated role:

```sql
CREATE ROLE hydra_app LOGIN PASSWORD 'strong-password';
GRANT USAGE ON SCHEMA hydra TO hydra_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hydra TO hydra_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hydra TO hydra_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hydra TO hydra_app;
```

Verify isolation before you onboard a second tenant:

```sql
SET ROLE hydra_app;
SELECT set_config('hydra.tenant_id', '<tenant-a-uuid>', false);
SELECT count(*) FROM products;   -- must show only tenant A
```

---

## 6. Partitioning a large tenant

Everyone lands in `products_default`. When a tenant gets big enough to affect
others, give them their own partition:

```sql
CREATE TABLE products_t_acme PARTITION OF products FOR VALUES IN ('<uuid>');
-- move rows, then rebuild the HNSW index on that partition only
```

---

## 7. Scheduled jobs

Enable `pg_cron` and schedule retention nightly:

```sql
SELECT cron.schedule('hydra-purge', '0 3 * * *', $$SELECT hydra.hydra_purge(90)$$);
```

---

## 8. Backups

Point-in-time recovery on. The catalog index is rebuildable from a full sync,
but `visitor_events`, `merch_rules` and `usage_meter` are not — those are the
tables worth protecting.
