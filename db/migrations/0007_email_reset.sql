-- ============================================================================
-- Hydra 0007 — password reset and outbound email
--
-- Reset tokens get the same treatment as API keys and invites: stored hashed,
-- single use, short lived. A reset link in an inbox is a credential that can
-- take over an account, so it is the most sensitive of the three.
-- ============================================================================

SET search_path = hydra, public;

CREATE TABLE password_resets (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
    token_hash  bytea       NOT NULL,
    -- 30 minutes. Long enough to find the email, short enough that a forwarded
    -- or logged link is unlikely to still work.
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
    used_at     timestamptz,
    requested_ip inet,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON password_resets (token_hash) WHERE used_at IS NULL;
CREATE INDEX ON password_resets (user_id, created_at DESC);

/**
 * Rate limit resets per user. Without this the endpoint is a free email
 * cannon pointed at any address someone knows.
 */
CREATE OR REPLACE FUNCTION reset_allowed(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT count(*) < 3 FROM password_resets
     WHERE user_id = p_user AND created_at > now() - interval '1 hour';
$$;

-- ---------------------------------------------------------------------------
-- Email log
-- ---------------------------------------------------------------------------
-- Every outbound message. Answers "did they actually get the invite?" without
-- logging into the provider, and gives support something to point at.

CREATE TABLE email_log (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid,
    to_email    text        NOT NULL,
    template    text        NOT NULL,
    subject     text,
    provider    text,
    provider_id text,
    status      text        NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sent','failed','suppressed')),
    error       text,
    request_id  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    sent_at     timestamptz
);
CREATE INDEX ON email_log (tenant_id, created_at DESC);
CREATE INDEX ON email_log (to_email, created_at DESC);
CREATE INDEX ON email_log (status) WHERE status = 'failed';

-- Hard bounces and complaints. Sending to a known-bad address repeatedly is how
-- a sending domain's reputation dies.
CREATE TABLE email_suppressions (
    email       text PRIMARY KEY,
    reason      text NOT NULL CHECK (reason IN ('bounce','complaint','manual')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- Quota warnings should fire once per threshold per period, not on every
-- request that crosses the line.
ALTER TABLE usage_meter
    ADD COLUMN warned_80  boolean NOT NULL DEFAULT false,
    ADD COLUMN warned_100 boolean NOT NULL DEFAULT false;

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_log
    USING (tenant_id = current_tenant() OR tenant_id IS NULL);
