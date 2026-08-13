-- ============================================================================
-- Algivo 0006 — users, roles, per-site scoping, audit
--
-- Three things this has to get right:
--
-- 1. Site scoping. A merchandiser for the India storefront must not be able to
--    edit rules on the GCC one. Roles alone are not enough; access is
--    (user, role, site) not just (user, role).
--
-- 2. Revocation must be immediate. The previous JWT carried the role as a
--    claim, so demoting someone left them with their old permissions until the
--    token expired - up to 12 hours. Role is now loaded from the database on
--    every request and the token carries only the user id.
--
-- 3. You can never remove the last owner. Enforced by trigger, not by
--    application code, because application code gets bypassed.
-- ============================================================================

SET search_path = algivo, public;

DROP TYPE IF EXISTS console_role CASCADE;
CREATE TYPE console_role AS ENUM (
    'owner',          -- billing, users, deletion. Cannot be removed if last one.
    'admin',          -- everything except billing and tenant deletion
    'developer',      -- keys, syncs, health, environments. Scoped to sites.
    'merchandiser',   -- rules, cache flush, query reports. Scoped to sites.
    'viewer'          -- read only
);

-- The original column carried CHECK (role IN ('owner','merchandiser','viewer')).
-- Changing the column to an enum leaves that constraint behind, where it
-- becomes console_role = text and has no operator. Drop it first.
ALTER TABLE console_users DROP CONSTRAINT IF EXISTS console_users_role_check;

ALTER TABLE console_users
    ALTER COLUMN role DROP DEFAULT,
    -- role::text is required: the column is already an enum in some paths, and
    -- comparing an enum to a text literal has no operator.
    ALTER COLUMN role TYPE console_role USING (
        CASE role::text WHEN 'owner' THEN 'owner'::console_role
                        WHEN 'admin' THEN 'admin'::console_role
                        WHEN 'merchandiser' THEN 'merchandiser'::console_role
                        WHEN 'developer' THEN 'developer'::console_role
                        ELSE 'viewer'::console_role END),
    ALTER COLUMN role SET DEFAULT 'viewer';

ALTER TABLE console_users
    ADD COLUMN status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','suspended','invited')),
    ADD COLUMN last_seen_at timestamptz,
    ADD COLUMN failed_logins smallint NOT NULL DEFAULT 0,
    ADD COLUMN locked_until timestamptz,
    -- Bumped on password change, role change or suspension. Any token issued
    -- before this timestamp is rejected, which is what makes revocation
    -- immediate without a session store.
    ADD COLUMN token_valid_from timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- Per-site scoping
-- ---------------------------------------------------------------------------
-- No rows for a user means "all sites in the tenant". Owners and admins always
-- see everything regardless of what is in here.

CREATE TABLE user_sites (
    user_id  uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
    site_id  uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, site_id)
);
CREATE INDEX ON user_sites (site_id);

/**
 * Can this user act on this site? Owners and admins always can.
 * Scoped roles can only if explicitly granted, or if they have no grants at
 * all (which means tenant-wide).
 */
CREATE OR REPLACE FUNCTION user_can_access_site(p_user uuid, p_site uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1 FROM console_users u
         WHERE u.id = p_user
           AND u.status = 'active'
           AND (u.role IN ('owner','admin')
                OR NOT EXISTS (SELECT 1 FROM user_sites us WHERE us.user_id = p_user)
                OR EXISTS (SELECT 1 FROM user_sites us
                            WHERE us.user_id = p_user AND us.site_id = p_site))
    );
$$;

-- ---------------------------------------------------------------------------
-- Last-owner protection
-- ---------------------------------------------------------------------------
-- In the database, not the application. Application checks get bypassed by the
-- next endpoint someone adds; a trigger does not.

CREATE OR REPLACE FUNCTION guard_last_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_owners integer;
BEGIN
    IF (TG_OP = 'DELETE' AND OLD.role = 'owner')
       OR (TG_OP = 'UPDATE' AND OLD.role = 'owner'
           AND (NEW.role <> 'owner' OR NEW.status <> 'active')) THEN
        SELECT count(*) INTO v_owners
          FROM console_users
         WHERE tenant_id = OLD.tenant_id AND role = 'owner' AND status = 'active'
           AND id <> OLD.id;
        IF v_owners = 0 THEN
            RAISE EXCEPTION 'cannot remove the last owner of this account'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER console_users_last_owner
    BEFORE UPDATE OR DELETE ON console_users
    FOR EACH ROW EXECUTE FUNCTION guard_last_owner();

-- ---------------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------------
-- Token is stored hashed, single use, and expires. Same reasoning as API keys:
-- an invite link in an inbox is a credential.

CREATE TABLE user_invites (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       text         NOT NULL,
    role        console_role NOT NULL DEFAULT 'viewer',
    site_ids    uuid[]       NOT NULL DEFAULT '{}',
    token_hash  bytea        NOT NULL,
    invited_by  uuid         REFERENCES console_users(id) ON DELETE SET NULL,
    accepted_at timestamptz,
    revoked_at  timestamptz,
    expires_at  timestamptz  NOT NULL DEFAULT now() + interval '7 days',
    created_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON user_invites (token_hash) WHERE accepted_at IS NULL;
CREATE INDEX ON user_invites (tenant_id, email);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
-- Who did what, when, from where. Every state-changing action writes here.
-- Append-only by policy: no UPDATE or DELETE grant is issued to algivo_app.

CREATE TABLE audit_log (
    id          bigserial   PRIMARY KEY,
    tenant_id   uuid        NOT NULL,
    actor_id    uuid,
    actor_email text,
    action      text        NOT NULL,
    target_type text,
    target_id   text,
    site_id     uuid,
    detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
    ip          inet,
    user_agent  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (tenant_id, created_at DESC);
CREATE INDEX ON audit_log (tenant_id, action, created_at DESC);

-- ---------------------------------------------------------------------------
-- Platform staff
-- ---------------------------------------------------------------------------
-- Your own team, separate from merchant users. Cross-tenant, read-only by
-- default. Impersonation is possible but always audited and time-boxed - a
-- support engineer who can silently act as a customer is a compliance problem.

CREATE TABLE platform_staff (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    role          text NOT NULL DEFAULT 'support'
                  CHECK (role IN ('support','engineer','superadmin')),
    status        text NOT NULL DEFAULT 'active',
    token_valid_from timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE impersonation_sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    staff_id    uuid NOT NULL REFERENCES platform_staff(id),
    tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    reason      text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL DEFAULT now() + interval '2 hours',
    ended_at    timestamptz
);
CREATE INDEX ON impersonation_sessions (tenant_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

ALTER TABLE user_sites   ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log    FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON user_invites USING (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON audit_log    USING (tenant_id = current_tenant());
CREATE POLICY tenant_isolation ON user_sites USING (
    EXISTS (SELECT 1 FROM console_users u
             WHERE u.id = user_sites.user_id AND u.tenant_id = current_tenant()));

-- Convenience view for the users screen.
CREATE OR REPLACE VIEW user_directory AS
SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.status,
       u.last_login_at, u.last_seen_at, u.created_at,
       u.locked_until IS NOT NULL AND u.locked_until > now() AS locked,
       COALESCE(array_agg(s.external_site_id) FILTER (WHERE s.id IS NOT NULL), '{}')
           AS scoped_sites,
       (SELECT count(*) FROM user_sites x WHERE x.user_id = u.id) = 0 AS all_sites
  FROM console_users u
  LEFT JOIN user_sites us ON us.user_id = u.id
  LEFT JOIN sites s ON s.id = us.site_id
 GROUP BY u.id;
