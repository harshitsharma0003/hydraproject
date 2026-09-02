-- B2B vs B2C account type, held on the tenant.
--
-- Every tenant onboarded so far is a B2C storefront, so the default is 'b2c'
-- and existing rows keep working unchanged. New signups choose at sign-up.
--
-- B2B unlocks trade features (list/file upload search, quantity + pickup-location
-- intent). It lives on the tenant so both the console portal and the query
-- pipeline can branch on a single source of truth.

-- Schema-qualified: the migration runner connects without `algivo` on its
-- search_path, so an unqualified `tenants` is not found even though
-- algivo.tenants exists.
ALTER TABLE algivo.tenants
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'b2c';

ALTER TABLE algivo.tenants DROP CONSTRAINT IF EXISTS tenants_account_type_chk;
ALTER TABLE algivo.tenants
  ADD CONSTRAINT tenants_account_type_chk CHECK (account_type IN ('b2b', 'b2c'));
