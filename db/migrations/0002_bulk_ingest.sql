-- ============================================================================
-- Hydra 0002 — bulk ingest, async embedding, and queued fixes
--
-- Replaces synchronous embed-inside-the-request with a staging table plus a
-- background worker. The old path held an HTTP connection open for 5-10s per
-- batch because it called the embedding provider inline; a 200k-master catalog
-- became ~53 minutes of connected time with no resumability.
--
-- New shape:
--   SFTP drop (or HTTP chunk) -> ingest_chunks -> products_staging
--     -> promote into products -> embed_queue -> worker fills embeddings
--
-- Every stage is resumable and idempotent.
-- ============================================================================

SET search_path = hydra, public;


-- ---------------------------------------------------------------------------
-- 1. INGEST JOBS
-- ---------------------------------------------------------------------------

CREATE TYPE ingest_transport AS ENUM ('sftp', 'http', 'shopify_bulk');
CREATE TYPE ingest_state AS ENUM
    ('open', 'uploading', 'manifest_received', 'loading', 'promoting',
     'embedding', 'complete', 'failed', 'aborted');

CREATE TABLE ingest_jobs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id        uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    locale         text        NOT NULL DEFAULT 'en',
    mode           text        NOT NULL CHECK (mode IN ('full', 'delta')),
    transport      ingest_transport NOT NULL,
    state          ingest_state NOT NULL DEFAULT 'open',

    -- Filesystem prefix under the SFTP root. One directory per job so a failed
    -- run can be inspected or replayed without touching anything else.
    drop_prefix    text,
    expected_chunks integer,
    received_chunks integer     NOT NULL DEFAULT 0,
    rows_loaded    bigint      NOT NULL DEFAULT 0,
    rows_promoted  bigint      NOT NULL DEFAULT 0,
    rows_queued    bigint      NOT NULL DEFAULT 0,

    -- Manifest checksum. A job only promotes if every chunk is present and the
    -- row count matches what the exporter said it wrote.
    manifest       jsonb,
    error          text,

    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz
);
CREATE INDEX ON ingest_jobs (tenant_id, site_id, created_at DESC);
CREATE INDEX ON ingest_jobs (state) WHERE state NOT IN ('complete', 'failed', 'aborted');

CREATE TABLE ingest_chunks (
    job_id      uuid        NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
    seq         integer     NOT NULL,
    filename    text        NOT NULL,
    byte_size   bigint,
    row_count   integer,
    sha256      text,
    state       text        NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'loaded', 'failed')),
    error       text,
    loaded_at   timestamptz,
    PRIMARY KEY (job_id, seq)
);


-- ---------------------------------------------------------------------------
-- 2. STAGING
-- ---------------------------------------------------------------------------
-- Unlogged: contents are disposable and rebuilt on every sync, so WAL traffic
-- is pure waste here. Roughly 2-3x faster bulk load.

CREATE UNLOGGED TABLE products_staging (
    job_id        uuid        NOT NULL,
    tenant_id     uuid        NOT NULL,
    site_id       uuid        NOT NULL,
    master_id     text        NOT NULL,
    locale        text        NOT NULL,
    title         text,
    description   text,
    brand         text,
    handle        text,
    category_path text[],
    attrs         jsonb,
    colors        text[],
    sizes         text[],
    variant_count integer,
    list_price    numeric(12,2),
    currency      char(3),
    online        boolean,
    in_stock_hint boolean,
    content_hash  text        NOT NULL,
    PRIMARY KEY (job_id, master_id, locale)
);
CREATE INDEX ON products_staging (job_id);


-- ---------------------------------------------------------------------------
-- 3. EMBEDDING QUEUE
-- ---------------------------------------------------------------------------
-- Only rows whose content_hash changed land here. In a live catalog that is
-- 1-3% per day. Workers claim batches with SKIP LOCKED so several can run in
-- parallel without coordination.

CREATE TABLE embed_queue (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    site_id     uuid        NOT NULL,
    master_id   text        NOT NULL,
    locale      text        NOT NULL,
    job_id      uuid,
    text_to_embed text      NOT NULL,
    attempts    smallint    NOT NULL DEFAULT 0,
    claimed_at  timestamptz,
    claimed_by  text,
    error       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, site_id, master_id, locale)
);
CREATE INDEX ON embed_queue (claimed_at NULLS FIRST, id) WHERE attempts < 5;
CREATE INDEX ON embed_queue (job_id);

/**
 * Claim a batch. SKIP LOCKED lets N workers run without a coordinator.
 * Stale claims (worker died mid-batch) are reclaimed after 10 minutes.
 */
CREATE OR REPLACE FUNCTION embed_claim(p_worker text, p_limit integer DEFAULT 128)
RETURNS SETOF embed_queue LANGUAGE sql AS $$
    UPDATE embed_queue q
       SET claimed_at = now(), claimed_by = p_worker, attempts = q.attempts + 1
     WHERE q.id IN (
         SELECT id FROM embed_queue
          WHERE attempts < 5
            AND (claimed_at IS NULL OR claimed_at < now() - interval '10 minutes')
          ORDER BY id
          LIMIT p_limit
          FOR UPDATE SKIP LOCKED)
    RETURNING q.*;
$$;


-- ---------------------------------------------------------------------------
-- 4. PROMOTION
-- ---------------------------------------------------------------------------
-- Staging -> products in one statement, then queue only what actually changed.

CREATE OR REPLACE FUNCTION ingest_promote(p_job_id uuid)
RETURNS TABLE (promoted bigint, queued bigint) LANGUAGE plpgsql AS $$
DECLARE
    v_tenant uuid;
    v_site   uuid;
    v_mode   text;
    v_promoted bigint;
    v_queued   bigint;
BEGIN
    SELECT tenant_id, site_id, mode INTO v_tenant, v_site, v_mode
      FROM ingest_jobs WHERE id = p_job_id;

    INSERT INTO products AS p (
        tenant_id, site_id, master_id, locale, title, description, brand,
        category_path, attrs, colors, sizes, variant_count, list_price,
        currency, online, in_stock_hint, content_hash, updated_at)
    SELECT s.tenant_id, s.site_id, s.master_id, s.locale,
           s.title, coalesce(s.description,''), s.brand,
           coalesce(s.category_path,'{}'), coalesce(s.attrs,'{}'::jsonb),
           coalesce(s.colors,'{}'), coalesce(s.sizes,'{}'),
           coalesce(s.variant_count,1), s.list_price, s.currency,
           coalesce(s.online,true), coalesce(s.in_stock_hint,true),
           s.content_hash, now()
      FROM products_staging s
     WHERE s.job_id = p_job_id
    ON CONFLICT (tenant_id, site_id, master_id, locale) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        brand = EXCLUDED.brand,
        category_path = EXCLUDED.category_path,
        attrs = EXCLUDED.attrs,
        colors = EXCLUDED.colors,
        sizes = EXCLUDED.sizes,
        variant_count = EXCLUDED.variant_count,
        list_price = EXCLUDED.list_price,
        currency = EXCLUDED.currency,
        online = EXCLUDED.online,
        in_stock_hint = EXCLUDED.in_stock_hint,
        content_hash = EXCLUDED.content_hash,
        -- Embedding is deliberately NOT cleared. The old vector stays live and
        -- searchable until the worker replaces it, so a resync never blanks the
        -- index mid-flight.
        updated_at = now();
    GET DIAGNOSTICS v_promoted = ROW_COUNT;

    -- Queue only rows whose embeddable text actually changed.
    INSERT INTO embed_queue (tenant_id, site_id, master_id, locale, job_id, text_to_embed)
    SELECT p.tenant_id, p.site_id, p.master_id, p.locale, p_job_id,
           concat_ws(E'\n',
               p.title, p.brand, left(p.description, 1200),
               array_to_string(p.category_path, ' > '),
               (SELECT string_agg(k || ': ' || array_to_string(
                          ARRAY(SELECT jsonb_array_elements_text(p.attrs -> k)), ', '), '; ')
                  FROM jsonb_object_keys(p.attrs) k))
      FROM products p
      JOIN products_staging s
        ON s.tenant_id = p.tenant_id AND s.site_id = p.site_id
       AND s.master_id = p.master_id AND s.locale = p.locale
     WHERE s.job_id = p_job_id
       AND (p.embedding IS NULL
            OR p.embed_model IS DISTINCT FROM current_setting('hydra.embed_model', true))
    ON CONFLICT (tenant_id, site_id, master_id, locale) DO UPDATE
        SET text_to_embed = EXCLUDED.text_to_embed,
            attempts = 0, claimed_at = NULL, error = NULL;
    GET DIAGNOSTICS v_queued = ROW_COUNT;

    -- A full sync marks anything absent from the export as offline rather than
    -- deleting it. Deleting loses history and makes an accidental partial
    -- export catastrophic; offline is reversible.
    IF v_mode = 'full' THEN
        UPDATE products p SET online = false, updated_at = now()
         WHERE p.tenant_id = v_tenant AND p.site_id = v_site AND p.online
           AND NOT EXISTS (SELECT 1 FROM products_staging s
                            WHERE s.job_id = p_job_id
                              AND s.master_id = p.master_id
                              AND s.locale = p.locale);
    END IF;

    DELETE FROM products_staging WHERE job_id = p_job_id;
    DELETE FROM query_cache WHERE tenant_id = v_tenant AND site_id = v_site;

    promoted := v_promoted;
    queued := v_queued;
    RETURN NEXT;
END $$;


-- ---------------------------------------------------------------------------
-- 5. RATE LIMITING
-- ---------------------------------------------------------------------------
-- Quota metering alone is monthly. A runaway storefront loop can burn a month
-- of quota in minutes, so this is the per-minute guard in front of it.

CREATE TABLE rate_buckets (
    api_key_id  uuid        NOT NULL,
    window_start timestamptz NOT NULL,
    hits        integer     NOT NULL DEFAULT 0,
    PRIMARY KEY (api_key_id, window_start)
);
CREATE INDEX ON rate_buckets (window_start);

CREATE OR REPLACE FUNCTION rate_check(p_key uuid, p_limit integer)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE v_hits integer; v_window timestamptz;
BEGIN
    v_window := date_trunc('minute', now());
    INSERT INTO rate_buckets (api_key_id, window_start, hits)
    VALUES (p_key, v_window, 1)
    ON CONFLICT (api_key_id, window_start)
    DO UPDATE SET hits = rate_buckets.hits + 1
    RETURNING hits INTO v_hits;
    RETURN v_hits <= p_limit;
END $$;


-- ---------------------------------------------------------------------------
-- 6. QUEUED FIXES
-- ---------------------------------------------------------------------------

-- A multiplier of 0 made ln(0) raise, breaking EVERY query on that site.
-- Entering 0 to hide a product is a completely plausible merchandiser action.
ALTER TABLE merch_rules
    ADD CONSTRAINT merch_rules_multiplier_positive CHECK (multiplier > 0);

-- console_users is tenant-scoped but was added after the RLS loop, so it had
-- no policy. A bug in requireConsole would have exposed every tenant's users.
ALTER TABLE console_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE console_users FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON console_users
    USING (tenant_id = current_tenant() OR current_tenant() IS NULL);

ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingest_jobs USING (tenant_id = current_tenant());

ALTER TABLE products_staging ENABLE ROW LEVEL SECURITY;
ALTER TABLE products_staging FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON products_staging USING (tenant_id = current_tenant());

ALTER TABLE embed_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE embed_queue FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON embed_queue USING (tenant_id = current_tenant());

-- Per-site SFTP account. The username maps a login to exactly one site, so a
-- compromised credential cannot reach another tenant's drop directory.
ALTER TABLE sites ADD COLUMN sftp_username text UNIQUE;
ALTER TABLE sites ADD COLUMN sftp_enabled boolean NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 7. RETENTION FOR THE NEW TABLES
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION hydra_purge(p_days integer DEFAULT 90)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM query_tokens   WHERE expires_at < now();
    DELETE FROM query_cache    WHERE expires_at < now();
    DELETE FROM rate_buckets   WHERE window_start < now() - interval '1 hour';
    DELETE FROM visitor_events WHERE occurred_at < now() - make_interval(days => p_days);
    DELETE FROM visitors       WHERE last_seen   < now() - make_interval(days => p_days);
    DELETE FROM ingest_jobs    WHERE completed_at < now() - interval '30 days';
    -- Orphaned staging from an aborted job
    DELETE FROM products_staging s
     WHERE NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.id = s.job_id);
    DELETE FROM embed_queue WHERE attempts >= 5 AND created_at < now() - interval '7 days';
END $$;
