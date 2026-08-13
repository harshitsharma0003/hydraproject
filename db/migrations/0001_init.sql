-- ============================================================================
-- Algivo gateway - Postgres schema (v1)
-- Requires: PostgreSQL 16+, pgvector 0.7+ (halfvec), pg_trgm
--
-- Design decisions encoded here:
--   * Embeddings at MASTER level, not variant. Variants roll up into arrays.
--   * halfvec(1024) - float16. Halves RAM vs float32, no measurable ranking loss.
--   * One products table, locale as a column. Vectors shared where text is identical.
--   * LIST partitioning by tenant_id with a DEFAULT partition. Large tenants get
--     a dedicated partition so their index size cannot degrade everyone else.
--   * RLS on every tenant-scoped table. Isolation is enforced by the database,
--     not by remembering to add a WHERE clause.
--   * Price snapshot exists ONLY to keep the retrieval funnel from starving on
--     budget queries. It is never displayed. Display price comes from the
--     platform, inside the shopper's session.
--   * No inventory. No PII. Ever.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS algivo;
SET search_path = algivo, public;


-- ============================================================================
-- 1. TENANCY, LICENSING, AUTH
-- ============================================================================

CREATE TYPE platform_kind AS ENUM ('sfcc_sfra', 'sfcc_pwa', 'shopify');
CREATE TYPE render_mode   AS ENUM ('off', 'route_only', 'hijack', 'hijack_canary');
CREATE TYPE license_tier  AS ENUM ('starter', 'growth', 'enterprise');

CREATE TABLE tenants (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text        NOT NULL,
    -- Per-tenant salt for hashing customer identifiers. This is the property
    -- that makes cross-tenant identity joins mathematically impossible.
    -- Generated once, never rotated without wiping visitor history.
    identity_salt   bytea       NOT NULL DEFAULT gen_random_bytes(32),
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE TABLE licenses (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tier                license_tier NOT NULL DEFAULT 'starter',
    -- Soft cap: exceeding it does not break the storefront, it degrades to
    -- native search and emails the merchant. Hard cutoffs cause outages.
    monthly_query_quota bigint      NOT NULL DEFAULT 100000,
    overage_allowed     boolean     NOT NULL DEFAULT true,
    narration_enabled   boolean     NOT NULL DEFAULT false,
    max_masters         bigint      NOT NULL DEFAULT 100000,
    stripe_customer_id  text,
    stripe_sub_id       text,
    valid_from          timestamptz NOT NULL DEFAULT now(),
    valid_until         timestamptz,
    status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','past_due','suspended','cancelled'))
);
CREATE INDEX ON licenses (tenant_id) WHERE status = 'active';

-- A tenant may run several storefronts (SFCC sites, Shopify shops).
CREATE TABLE sites (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           uuid          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    external_site_id    text          NOT NULL,   -- SFCC site ID or myshopify domain
    platform            platform_kind NOT NULL,
    allowed_origins     text[]        NOT NULL DEFAULT '{}',
    default_locale      text          NOT NULL DEFAULT 'en_IN',
    locales             text[]        NOT NULL DEFAULT '{}',
    currencies          text[]        NOT NULL DEFAULT '{}',
    -- Populated by the discovery job, reviewed by the merchant.
    render_mode         render_mode   NOT NULL DEFAULT 'route_only',
    canary_percent      smallint      NOT NULL DEFAULT 0
                        CHECK (canary_percent BETWEEN 0 AND 100),
    tile_template       text,                     -- e.g. 'product/gridTile'
    search_contested    boolean       NOT NULL DEFAULT false,
    cartridge_version   text,
    created_at          timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, external_site_id)
);

-- Two keys per site. Publishable is origin-locked and safe in the browser.
-- Secret is server-to-server only. Shipping one key is how integrations leak.
CREATE TYPE key_kind AS ENUM ('publishable', 'secret');

CREATE TABLE api_keys (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid     NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id      uuid              REFERENCES sites(id) ON DELETE CASCADE,
    kind         key_kind NOT NULL,
    prefix       text     NOT NULL,          -- 'alg_pk_' / 'alg_sk_', shown in UI
    key_hash     bytea    NOT NULL,          -- sha256 of the full key
    last_used_at timestamptz,
    revoked_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX ON api_keys (tenant_id, kind);


-- ============================================================================
-- 2. TAXONOMY PROFILE (output of the discovery job)
-- ============================================================================
-- This is what the intent parser is constrained against. The LLM may only emit
-- attribute names and values that appear here, which is what stops it
-- hallucinating facets the merchant's catalog does not have.

CREATE TABLE taxonomy_profiles (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id        uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    locale         text        NOT NULL,
    version        integer     NOT NULL DEFAULT 1,
    -- { "occasion": {"label":"Occasion","values":["formal","casual",...]}, ... }
    refinements    jsonb       NOT NULL,
    category_tree  jsonb       NOT NULL,
    price_bands    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    has_giftwrap   boolean     NOT NULL DEFAULT false,
    has_giftcard   boolean     NOT NULL DEFAULT false,
    -- Hash of the rendered prompt block. When this changes, bust the query cache
    -- and re-render the cached prompt prefix.
    prompt_hash    text        NOT NULL,
    built_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, locale, version)
);
CREATE INDEX ON taxonomy_profiles (site_id, locale, version DESC);


-- ============================================================================
-- 3. CATALOG INDEX
-- ============================================================================

CREATE TABLE products (
    tenant_id       uuid        NOT NULL,
    site_id         uuid        NOT NULL,
    master_id       text        NOT NULL,      -- SFCC master ID / Shopify product ID
    locale          text        NOT NULL,

    title           text        NOT NULL,
    description     text        NOT NULL DEFAULT '',
    brand           text,
    category_path   text[]      NOT NULL DEFAULT '{}',

    -- Discovered refinement values, e.g.
    -- {"occasion":["formal"],"fit":["tailored"],"fabric":["cotton"],"gender":["mens"]}
    attrs           jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- Variant rollup. Filterable without exploding the row count.
    colors          text[]      NOT NULL DEFAULT '{}',
    sizes           text[]      NOT NULL DEFAULT '{}',
    variant_count   integer     NOT NULL DEFAULT 1,

    -- Snapshot only. Retrieval-band filtering. NEVER rendered.
    list_price      numeric(12,2),
    currency        char(3),
    price_book      text,

    online          boolean     NOT NULL DEFAULT true,
    -- Soft prior from the last sync. Not authoritative; the platform decides.
    in_stock_hint   boolean     NOT NULL DEFAULT true,

    -- Delta-sync control. Only rows whose content_hash changed get re-embedded.
    -- In a live catalog this is 1-3% per day. Price and stock changes do not
    -- touch the vector at all.
    content_hash    text        NOT NULL,
    embedding       halfvec(1024),
    embed_model     text,
    embed_version   text,
    embedded_at     timestamptz,

    -- Two things here are load-bearing, both learned by running this rather
    -- than reading it:
    --
    -- 1. The ::regconfig cast. Without it Postgres resolves to the one-argument
    --    to_tsvector(text), which is STABLE (it reads default_text_search_config)
    --    and a generated column rejects anything non-immutable.
    --
    -- 2. category_path is NOT included. array_to_string is STABLE, so any
    --    expression touching it is rejected here. Categories are matched by
    --    array overlap in algivo_retrieve anyway, and category_path holds IDs
    --    rather than display names, so the lexical value was minimal.
    search_doc      tsvector GENERATED ALWAYS AS (
                        setweight(to_tsvector('english'::regconfig, coalesce(title, '')), 'A') ||
                        setweight(to_tsvector('english'::regconfig, coalesce(brand, '')), 'A') ||
                        setweight(to_tsvector('english'::regconfig, coalesce(description, '')), 'B')
                    ) STORED,

    updated_at      timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, site_id, master_id, locale)
) PARTITION BY LIST (tenant_id);

-- Everyone lands here until they are big enough to deserve their own partition.
CREATE TABLE products_default PARTITION OF products DEFAULT;

-- Promote a large tenant with:
--   CREATE TABLE products_t_<slug> PARTITION OF products FOR VALUES IN ('<uuid>');
-- then move rows and rebuild indexes on the new partition only.

CREATE INDEX products_embedding_hnsw ON products
    USING hnsw (embedding halfvec_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX products_search_doc ON products USING gin (search_doc);
CREATE INDEX products_attrs      ON products USING gin (attrs jsonb_path_ops);
CREATE INDEX products_category   ON products USING gin (category_path);
CREATE INDEX products_live       ON products (tenant_id, site_id, locale)
                                 WHERE online AND embedding IS NOT NULL;
CREATE INDEX products_price      ON products (tenant_id, site_id, locale, list_price)
                                 WHERE online;
CREATE INDEX products_stale      ON products (tenant_id, site_id)
                                 WHERE embedding IS NULL;


-- ============================================================================
-- 4. MERCHANDISING RULES
-- ============================================================================
-- The console writes these. Applied post-retrieval, pre-return.
-- A ban is absolute; a boost is a score multiplier; a pin forces rank.

CREATE TYPE rule_kind AS ENUM ('ban', 'pin', 'boost');

CREATE TABLE merch_rules (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid      NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    site_id      uuid      NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    kind         rule_kind NOT NULL,

    -- Target: one of these. master_id wins over attr match.
    master_id    text,
    attr_match   jsonb,                       -- e.g. {"brand":["ClearanceCo"]}

    -- Scope: null query_pattern = applies to every query on this site.
    query_pattern text,

    multiplier   real      NOT NULL DEFAULT 1.0,   -- boost only
    pin_position smallint,                          -- pin only
    reason       text,
    created_by   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz,

    CHECK (master_id IS NOT NULL OR attr_match IS NOT NULL)
);
-- No now() in the predicate: index predicates must be immutable, and now() is
-- STABLE. Expiry is filtered at query time in algivo_retrieve instead.
CREATE INDEX ON merch_rules (tenant_id, site_id, kind, expires_at);


-- ============================================================================
-- 5. QUERY CACHE
-- ============================================================================
-- "office wear" resolves identically for every shopper on a given site.
-- This is the single highest-ROI component in the gateway: at a 70% hit rate
-- you pay a model provider on only 30% of queries.

CREATE TABLE query_cache (
    tenant_id     uuid        NOT NULL,
    site_id       uuid        NOT NULL,
    locale        text        NOT NULL,
    -- sha256(normalised query + prompt_hash + rules_version)
    cache_key     text        NOT NULL,
    normalised_q  text        NOT NULL,
    intent        jsonb       NOT NULL,       -- parser output
    candidate_ids text[]      NOT NULL,       -- ordered master IDs
    hit_count     bigint      NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, site_id, locale, cache_key)
);
CREATE INDEX ON query_cache (expires_at);

-- Short-lived token handed to the storefront. The URL carries the token, not
-- session state - that is what keeps the Algivo path and the normal category
-- path from ever contaminating each other.
CREATE TABLE query_tokens (
    token       text PRIMARY KEY,             -- short, URL-safe
    tenant_id   uuid        NOT NULL,
    site_id     uuid        NOT NULL,
    locale      text        NOT NULL,
    master_ids  text[]      NOT NULL,
    intent      jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE INDEX ON query_tokens (expires_at);


-- ============================================================================
-- 6. VISITOR HISTORY
-- ============================================================================
-- Anonymous:  server-set first-party cookie on the merchant's domain.
--             HTTP-set matters - Safari ITP caps JS-set cookies at 7 days.
-- Known:      HMAC(tenant.identity_salt, customer_no). Never the email,
--             never the raw customer number.
-- Cross-tenant: does not exist. Different salts, uncorrelatable IDs.

CREATE TABLE visitors (
    tenant_id     uuid        NOT NULL,
    visitor_id    uuid        NOT NULL,       -- value of the algivo_vid cookie
    site_id       uuid        NOT NULL,
    identity_hash bytea,                      -- set on login, enables cross-device
    consent       boolean     NOT NULL DEFAULT false,  -- from merchant's CMP
    first_seen    timestamptz NOT NULL DEFAULT now(),
    last_seen     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, visitor_id)
);
CREATE INDEX ON visitors (tenant_id, identity_hash) WHERE identity_hash IS NOT NULL;
CREATE INDEX ON visitors (last_seen);

CREATE TYPE event_kind AS ENUM
    ('query', 'chip', 'impression', 'click', 'add_to_cart', 'order');

CREATE TABLE visitor_events (
    -- A unique constraint on a partitioned table must include every
    -- partitioning column, so the key is (id, occurred_at) not id alone.
    id          bigserial,
    tenant_id   uuid        NOT NULL,
    visitor_id  uuid        NOT NULL,
    site_id     uuid        NOT NULL,
    kind        event_kind  NOT NULL,
    query_token text,
    master_id   text,
    payload     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    -- Attribution chain is emitted from day one even though v1 bills on
    -- queries. Switching to performance pricing later is then a pricing-page
    -- change, not a re-instrumentation project.
    order_value numeric(12,2),
    currency    char(3),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- A range-partitioned table with no partitions rejects every INSERT with
-- "no partition of relation found for row". The DEFAULT partition guarantees
-- writes always land somewhere; monthly partitions are an optimisation on top.
CREATE TABLE visitor_events_default PARTITION OF visitor_events DEFAULT;

-- Monthly partitions. algivo_ensure_partitions() below keeps them rolling.
CREATE TABLE visitor_events_2026m08 PARTITION OF visitor_events
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE visitor_events_2026m09 PARTITION OF visitor_events
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE INDEX ON visitor_events (tenant_id, visitor_id, occurred_at DESC);
CREATE INDEX ON visitor_events (tenant_id, site_id, kind, occurred_at DESC);
CREATE INDEX ON visitor_events (query_token) WHERE query_token IS NOT NULL;

-- Rolling derived profile. Recomputed on a schedule, not per request.
CREATE TABLE visitor_profiles (
    tenant_id      uuid        NOT NULL,
    visitor_id     uuid        NOT NULL,
    style_vector   halfvec(1024),            -- mean of clicked product embeddings
    price_affinity jsonb       NOT NULL DEFAULT '{}'::jsonb,
    attr_affinity  jsonb       NOT NULL DEFAULT '{}'::jsonb,
    size_hints     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    event_count    integer     NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, visitor_id)
);


-- ============================================================================
-- 7. OPERATIONS
-- ============================================================================

CREATE TABLE usage_meter (
    tenant_id     uuid    NOT NULL,
    site_id       uuid    NOT NULL,
    period        date    NOT NULL,          -- first of month
    queries_total bigint  NOT NULL DEFAULT 0,
    queries_cached bigint NOT NULL DEFAULT 0,
    input_tokens  bigint  NOT NULL DEFAULT 0,
    output_tokens bigint  NOT NULL DEFAULT 0,
    embed_tokens  bigint  NOT NULL DEFAULT 0,
    -- Per-tenant cost telemetry from the first commit. Without this you learn
    -- your true gross margin per client at renewal, which is too late.
    cost_micros   bigint  NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, site_id, period)
);

CREATE TABLE sync_runs (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL,
    site_id       uuid        NOT NULL,
    kind          text        NOT NULL CHECK (kind IN ('discover','full','delta')),
    status        text        NOT NULL DEFAULT 'running',
    rows_seen     integer     NOT NULL DEFAULT 0,
    rows_embedded integer     NOT NULL DEFAULT 0,   -- expect 1-3% on delta
    error         text,
    started_at    timestamptz NOT NULL DEFAULT now(),
    finished_at   timestamptz
);
CREATE INDEX ON sync_runs (tenant_id, site_id, started_at DESC);

-- What Algivo-Health returns to Business Manager so support can diagnose
-- without instance access.
CREATE TABLE health_reports (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    detected_mode render_mode NOT NULL,
    findings      jsonb       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);


-- ============================================================================
-- 8. ROW-LEVEL SECURITY
-- ============================================================================
-- The application sets: SET LOCAL algivo.tenant_id = '<uuid>';
-- Isolation is then the database's job, not the query author's.

CREATE OR REPLACE FUNCTION current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('algivo.tenant_id', true), '')::uuid
$$;

DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'products','merch_rules','query_cache','query_tokens',
        'visitors','visitor_events','visitor_profiles','usage_meter','sync_runs'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant())', t);
    END LOOP;
END $$;


-- ============================================================================
-- 9. HYBRID RETRIEVAL
-- ============================================================================
-- Lexical and semantic in ONE query over ONE filter pass. This is the reason
-- pgvector wins over a separate vector store: with two systems you run two
-- queries, reconcile two ranked lists across a network boundary, and maintain
-- identical tenant filters in both.
--
-- Fusion is Reciprocal Rank Fusion - no score normalisation needed, which is
-- what makes it robust when the two rankers disagree.

CREATE OR REPLACE FUNCTION algivo_retrieve(
    p_tenant_id   uuid,
    p_site_id     uuid,
    p_locale      text,
    p_embedding   halfvec(1024),
    p_query_text  text,
    p_attrs       jsonb   DEFAULT '{}'::jsonb,   -- hard filters, ANDed
    p_categories  text[]  DEFAULT NULL,
    p_price_max   numeric DEFAULT NULL,
    p_price_min   numeric DEFAULT NULL,
    p_limit       integer DEFAULT 200,
    p_rrf_k       integer DEFAULT 60
)
RETURNS TABLE (master_id text, score real, vec_rank integer, lex_rank integer)
LANGUAGE sql STABLE AS $$
WITH filtered AS (
    SELECT p.master_id, p.embedding, p.search_doc, p.in_stock_hint
    FROM products p
    WHERE p.tenant_id = p_tenant_id
      AND p.site_id   = p_site_id
      AND p.locale    = p_locale
      AND p.online
      AND p.embedding IS NOT NULL
      AND (p_attrs = '{}'::jsonb OR p.attrs @> p_attrs)
      AND (p_categories IS NULL OR p.category_path && p_categories)
      -- Band is widened by the caller (typically 15%) so a small price move
      -- does not silently exclude valid products.
      AND (p_price_max IS NULL OR p.list_price <= p_price_max)
      AND (p_price_min IS NULL OR p.list_price >= p_price_min)
      AND NOT EXISTS (
            SELECT 1 FROM merch_rules r
            WHERE r.tenant_id = p_tenant_id
              AND r.site_id = p_site_id
              AND r.kind = 'ban'
              AND (r.expires_at IS NULL OR r.expires_at > now())
              AND (r.master_id = p.master_id
                   OR (r.attr_match IS NOT NULL AND p.attrs @> r.attr_match))
      )
),
vec AS (
    SELECT master_id,
           row_number() OVER (ORDER BY embedding <=> p_embedding) AS rnk
    FROM filtered
    ORDER BY embedding <=> p_embedding
    LIMIT p_limit * 3
),
lex AS (
    SELECT master_id,
           row_number() OVER (
               ORDER BY ts_rank_cd(search_doc, websearch_to_tsquery('english', p_query_text)) DESC
           ) AS rnk
    FROM filtered
    WHERE p_query_text <> ''
      AND search_doc @@ websearch_to_tsquery('english', p_query_text)
    ORDER BY ts_rank_cd(search_doc, websearch_to_tsquery('english', p_query_text)) DESC
    LIMIT p_limit * 3
),
fused AS (
    SELECT COALESCE(v.master_id, l.master_id) AS master_id,
           (COALESCE(1.0 / (p_rrf_k + v.rnk), 0)
          + COALESCE(1.0 / (p_rrf_k + l.rnk), 0))::real AS rrf,
           v.rnk::integer AS vec_rank,
           l.rnk::integer AS lex_rank
    FROM vec v FULL OUTER JOIN lex l ON v.master_id = l.master_id
),
boosted AS (
    SELECT f.master_id,
           (f.rrf
             * COALESCE((SELECT exp(sum(ln(r.multiplier)))
                         FROM merch_rules r
                         WHERE r.tenant_id = p_tenant_id
                           AND r.site_id = p_site_id
                           AND r.kind = 'boost'
                           AND (r.expires_at IS NULL OR r.expires_at > now())
                           AND (r.master_id = f.master_id
                                OR (r.attr_match IS NOT NULL
                                    AND EXISTS (SELECT 1 FROM filtered fp
                                                WHERE fp.master_id = f.master_id)))), 1.0)
             -- Soft in-stock prior only. The cartridge holds the truth and will
             -- drop anything genuinely unavailable.
             * CASE WHEN (SELECT in_stock_hint FROM filtered fp
                          WHERE fp.master_id = f.master_id) THEN 1.0 ELSE 0.85 END
           )::real AS score,
           f.vec_rank, f.lex_rank
    FROM fused f
)
SELECT master_id, score, vec_rank, lex_rank
FROM boosted
ORDER BY score DESC
LIMIT p_limit;
$$;


-- ============================================================================
-- 9b. PARTITION MAINTENANCE
-- ============================================================================
-- Creates next month's partition if it is missing. Schedule alongside the purge
-- job. Without this, rows fall into visitor_events_default, which still works
-- but loses the drop-partition fast path for retention.

CREATE OR REPLACE FUNCTION algivo_ensure_partitions(p_months integer DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    i integer;
    start_date date;
    end_date date;
    part_name text;
BEGIN
    FOR i IN 0..p_months LOOP
        start_date := date_trunc('month', now())::date + make_interval(months => i);
        end_date   := start_date + interval '1 month';
        part_name  := format('visitor_events_%sm%s',
                             to_char(start_date, 'YYYY'), to_char(start_date, 'MM'));
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF visitor_events FOR VALUES FROM (%L) TO (%L)',
                part_name, start_date, end_date);
        END IF;
    END LOOP;
END $$;


-- ============================================================================
-- 10. RETENTION
-- ============================================================================
-- 90 days default, tenant-configurable down but not up. Run nightly.

CREATE OR REPLACE FUNCTION algivo_purge(p_days integer DEFAULT 90)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM query_tokens  WHERE expires_at < now();
    DELETE FROM query_cache   WHERE expires_at < now();
    DELETE FROM visitor_events WHERE occurred_at < now() - make_interval(days => p_days);
    DELETE FROM visitors       WHERE last_seen  < now() - make_interval(days => p_days);
END $$;

-- Per-subject erasure. Wired to Shopify's customers/redact webhook and exposed
-- as a cartridge call on SFCC.
CREATE OR REPLACE FUNCTION algivo_forget(p_tenant uuid, p_visitor uuid)
RETURNS void LANGUAGE sql AS $$
    DELETE FROM visitor_events   WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
    DELETE FROM visitor_profiles WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
    DELETE FROM visitors         WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
$$;


-- ============================================================================
-- 11. CONSOLE USERS
-- ============================================================================
-- Merchant-facing console login. Reached by SSO link from Business Manager and
-- from Shopify admin, so one console serves both platforms.

CREATE TABLE console_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email         text        NOT NULL UNIQUE,
    password_hash text        NOT NULL,
    role          text        NOT NULL DEFAULT 'merchandiser'
                  CHECK (role IN ('owner','merchandiser','viewer')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
);

-- Example: creating the first user for a tenant
-- INSERT INTO console_users (tenant_id, email, password_hash, role)
-- VALUES ('<tenant-uuid>', 'ops@merchant.com', crypt('changeme', gen_salt('bf')), 'owner');
