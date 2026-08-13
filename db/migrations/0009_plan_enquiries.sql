-- ============================================================================
-- Algivo 0009 — plan enquiries (sales-led billing)
--
-- Billing is manual: there is no self-serve card payment. The pricing page and
-- the billing screen collect a contact request instead of opening checkout, and
-- the team follows up and provisions the plan by hand. This table is where those
-- requests land.
--
-- Deliberately NOT tenant-scoped / no RLS: the homepage form is public (the
-- visitor has no tenant yet), so a request can arrive with tenant_id NULL. The
-- app connects as algivo_app, which gets INSERT here via the schema's default
-- privileges (this table is created by the owner, like every other).
-- ============================================================================

SET search_path = algivo, public;

CREATE TABLE IF NOT EXISTS plan_enquiries (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        REFERENCES tenants(id) ON DELETE SET NULL,
    name        text,
    email       text        NOT NULL,
    company     text,
    plan        text,
    message     text,
    source      text        NOT NULL DEFAULT 'landing',  -- landing | billing
    status      text        NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','contacted','won','closed')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON plan_enquiries (created_at DESC);
