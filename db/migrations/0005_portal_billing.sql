-- ============================================================================
-- Algivo 0005 — customer portal and self-serve billing
--
-- Adds what a merchant needs to sign up, pay, and manage their own account
-- without you touching psql.
--
-- One constraint shapes the whole design: secret keys are stored as SHA-256
-- hashes and cannot be recovered. So the portal shows prefix + last four only,
-- and "reveal" is really "rotate and show once". That is the correct behaviour
-- but it has to be explained in the UI or it reads as a bug.
-- ============================================================================

SET search_path = algivo, public;

-- Enough to identify a key in a list without being able to reconstruct it.
ALTER TABLE api_keys ADD COLUMN last4 char(4);
ALTER TABLE api_keys ADD COLUMN label text;

-- Trial tier: sandbox only, no production keys until a card is on file.
ALTER TYPE license_tier ADD VALUE IF NOT EXISTS 'trial' BEFORE 'starter';

ALTER TABLE tenants
    ADD COLUMN contact_email text,
    ADD COLUMN company       text,
    ADD COLUMN country       char(2) DEFAULT 'IN',
    ADD COLUMN gstin         text;

ALTER TABLE console_users
    ADD COLUMN name          text,
    ADD COLUMN invited_by    uuid,
    ADD COLUMN email_verified boolean NOT NULL DEFAULT false;

-- Invoice history, so the portal can show something before Stripe syncs.
CREATE TABLE invoices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    period        date        NOT NULL,
    currency      char(3)     NOT NULL DEFAULT 'INR',
    platform_fee_micros bigint NOT NULL DEFAULT 0,
    overage_micros      bigint NOT NULL DEFAULT 0,
    credits_applied     bigint NOT NULL DEFAULT 0,
    tax_micros          bigint NOT NULL DEFAULT 0,
    total_micros        bigint NOT NULL DEFAULT 0,
    status        text        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','open','paid','void','uncollectible')),
    stripe_invoice_id text,
    issued_at     timestamptz,
    paid_at       timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, period)
);
CREATE INDEX ON invoices (tenant_id, period DESC);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_tenant());

/**
 * Everything the portal's environment tabs need, in one query: keys, caps and
 * period-to-date usage per environment.
 */
CREATE OR REPLACE VIEW environment_detail AS
SELECT
    s.tenant_id,
    s.id                AS site_id,
    s.external_site_id,
    s.platform,
    s.environment,
    s.render_mode,
    s.cartridge_version,
    s.sftp_username,
    s.sftp_enabled,
    (s.environment = 'production')                       AS billable,
    CASE WHEN s.environment = 'production'
         THEN l.monthly_query_quota
         ELSE l.nonprod_monthly_query_cap END            AS query_cap,
    CASE WHEN s.environment = 'production'
         THEN NULL ELSE l.nonprod_max_masters END        AS master_cap,
    (SELECT count(*) FROM products p
      WHERE p.site_id = s.id AND p.online)               AS masters_indexed,
    (SELECT count(*) FROM products p
      WHERE p.site_id = s.id AND p.embedding IS NOT NULL) AS masters_embedded,
    COALESCE((SELECT sum(m.queries_total) FROM usage_meter m
               WHERE m.site_id = s.id
                 AND m.period = date_trunc('month', now())::date), 0) AS queries_this_period,
    COALESCE((SELECT sum(m.queries_cached) FROM usage_meter m
               WHERE m.site_id = s.id
                 AND m.period = date_trunc('month', now())::date), 0) AS cached_this_period,
    COALESCE((SELECT sum(m.degraded_queries) FROM usage_meter m
               WHERE m.site_id = s.id
                 AND m.period = date_trunc('month', now())::date), 0) AS degraded_this_period,
    (SELECT max(j.completed_at) FROM ingest_jobs j
      WHERE j.site_id = s.id AND j.state = 'complete')   AS last_sync_at
  FROM sites s
  JOIN licenses l ON l.tenant_id = s.tenant_id AND l.status IN ('active','past_due');
