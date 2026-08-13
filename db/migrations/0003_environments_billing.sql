-- ============================================================================
-- Algivo 0003 — environments, non-billable quotas, credit ledger
--
-- Every merchant needs at least three key pairs: sandbox (developer machines),
-- UAT (their staging instance), production. Before this migration all three
-- would have been separate `sites` rows under one tenant, sharing one monthly
-- quota — so their QA team's regression suite would eat production allowance
-- and appear on the invoice. That is the fastest way to lose a customer during
-- onboarding.
--
-- After this migration:
--   * every site carries an environment
--   * only production is metered and billed
--   * non-production has its own generous cap purely to stop runaway loops
--   * sandbox and UAT are capped on catalog size, because embeddings cost real
--     money even when the queries do not
-- ============================================================================

SET search_path = algivo, public;

CREATE TYPE site_environment AS ENUM ('sandbox', 'uat', 'production');

ALTER TABLE sites
    ADD COLUMN environment site_environment NOT NULL DEFAULT 'production';

-- A tenant may run several production storefronts (brand sites, regions), but
-- only one sandbox and one UAT per platform — otherwise "free environments"
-- becomes a way to get the product for nothing.
CREATE UNIQUE INDEX sites_one_nonprod_per_platform
    ON sites (tenant_id, platform, environment)
    WHERE environment <> 'production';

-- Non-production limits. Not commercial limits — guardrails so a broken loop in
-- a merchant's CI cannot cost you a five-figure model bill overnight.
ALTER TABLE licenses
    ADD COLUMN nonprod_monthly_query_cap bigint NOT NULL DEFAULT 20000,
    ADD COLUMN nonprod_max_masters       bigint NOT NULL DEFAULT 5000,
    ADD COLUMN included_queries          bigint NOT NULL DEFAULT 50000,
    ADD COLUMN overage_price_micros      bigint NOT NULL DEFAULT 600000,  -- INR 0.60
    ADD COLUMN currency                  char(3) NOT NULL DEFAULT 'INR',
    ADD COLUMN platform_fee_micros       bigint NOT NULL DEFAULT 25000000000; -- INR 25,000

ALTER TABLE usage_meter
    ADD COLUMN environment site_environment NOT NULL DEFAULT 'production',
    ADD COLUMN billable boolean NOT NULL DEFAULT true,
    -- Queries that fell back to native search are recorded but never charged.
    -- Billing a merchant for a request their shoppers never saw the benefit of
    -- costs far more in trust than it earns in revenue.
    ADD COLUMN degraded_queries bigint NOT NULL DEFAULT 0;

ALTER TABLE usage_meter DROP CONSTRAINT usage_meter_pkey;
ALTER TABLE usage_meter ADD PRIMARY KEY (tenant_id, site_id, period, environment);


-- ---------------------------------------------------------------------------
-- Quota resolution
-- ---------------------------------------------------------------------------
-- Returns the cap that applies to a given site, and whether it bills.

CREATE OR REPLACE FUNCTION quota_for_site(p_site_id uuid)
RETURNS TABLE (cap bigint, billable boolean, env site_environment)
LANGUAGE sql STABLE AS $$
    SELECT CASE WHEN s.environment = 'production'
                THEN l.monthly_query_quota
                ELSE l.nonprod_monthly_query_cap END,
           s.environment = 'production',
           s.environment
      FROM sites s
      JOIN licenses l ON l.tenant_id = s.tenant_id AND l.status = 'active'
     WHERE s.id = p_site_id
     LIMIT 1;
$$;


-- ---------------------------------------------------------------------------
-- Prepaid credit ledger
-- ---------------------------------------------------------------------------
-- Overage sells as prepaid blocks, not as a surprise invoice. A merchant
-- approves a purchase order far more readily than an unexpected charge, and
-- you get the cash earlier.

CREATE TABLE credit_ledger (
    id           bigserial PRIMARY KEY,
    tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kind         text        NOT NULL CHECK (kind IN ('purchase','consumption','grant','refund','expiry')),
    queries      bigint      NOT NULL,          -- positive = added, negative = used
    amount_micros bigint     NOT NULL DEFAULT 0,
    currency     char(3)     NOT NULL DEFAULT 'INR',
    stripe_ref   text,
    note         text,
    period       date,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz
);
CREATE INDEX ON credit_ledger (tenant_id, created_at DESC);

CREATE OR REPLACE FUNCTION credit_balance(p_tenant uuid)
RETURNS bigint LANGUAGE sql STABLE AS $$
    SELECT COALESCE(sum(queries), 0)
      FROM credit_ledger
     WHERE tenant_id = p_tenant
       AND (expires_at IS NULL OR expires_at > now());
$$;


-- ---------------------------------------------------------------------------
-- Billing view — what the invoice is built from
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW billing_summary AS
SELECT
    l.tenant_id,
    t.name,
    l.tier,
    l.currency,
    m.period,
    l.platform_fee_micros,
    l.included_queries,
    COALESCE(sum(m.queries_total) FILTER (WHERE m.billable), 0)   AS billable_queries,
    COALESCE(sum(m.queries_total) FILTER (WHERE NOT m.billable), 0) AS nonprod_queries,
    COALESCE(sum(m.degraded_queries), 0)                          AS degraded_queries,
    COALESCE(sum(m.queries_cached) FILTER (WHERE m.billable), 0)  AS cached_queries,
    GREATEST(COALESCE(sum(m.queries_total) FILTER (WHERE m.billable), 0)
             - l.included_queries, 0)                             AS overage_queries,
    GREATEST(COALESCE(sum(m.queries_total) FILTER (WHERE m.billable), 0)
             - l.included_queries, 0) * l.overage_price_micros    AS overage_micros,
    -- Your side of the ledger, so gross margin is visible per tenant per month
    -- rather than discovered at renewal.
    COALESCE(sum(m.cost_micros), 0)                               AS cogs_micros
  FROM licenses l
  JOIN tenants t ON t.id = l.tenant_id
  LEFT JOIN usage_meter m ON m.tenant_id = l.tenant_id
 GROUP BY l.tenant_id, t.name, l.tier, l.currency, m.period,
          l.platform_fee_micros, l.included_queries, l.overage_price_micros;


-- ---------------------------------------------------------------------------
-- Catalog cap for non-production
-- ---------------------------------------------------------------------------
-- Embedding a full production catalog into a sandbox costs real money for zero
-- revenue. Enforced at ingest.

CREATE OR REPLACE FUNCTION check_master_cap(p_site_id uuid, p_incoming bigint)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE v_env site_environment; v_cap bigint; v_current bigint;
BEGIN
    SELECT s.environment, l.nonprod_max_masters
      INTO v_env, v_cap
      FROM sites s JOIN licenses l ON l.tenant_id = s.tenant_id
     WHERE s.id = p_site_id LIMIT 1;

    IF v_env = 'production' THEN RETURN true; END IF;

    SELECT count(*) INTO v_current FROM products WHERE site_id = p_site_id;
    RETURN (v_current + p_incoming) <= v_cap;
END $$;

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON credit_ledger USING (tenant_id = current_tenant());
