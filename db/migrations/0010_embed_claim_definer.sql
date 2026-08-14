-- ============================================================================
-- Algivo 0010 — embed_claim runs as owner
--
-- The embedding worker is cross-tenant and connects as algivo_app, which is
-- subject to RLS. embed_queue has RLS enabled, and embed_claim() was created
-- with invoker's rights (LANGUAGE sql, no SECURITY DEFINER) - so when the worker
-- called it with no tenant context set, the RLS policy filtered out every row
-- and the claim returned nothing. Result: nothing ever embedded, silently.
--
-- This surfaced the first time the worker ran against a live Voyage key (it was
-- shipped "built, not yet run"). Running the claim as its owner lets it pull work
-- across tenants; isolation is preserved because the worker sets the per-row
-- tenant context (set_config algivo.tenant_id) before writing each embedding.
-- ============================================================================

SET search_path = algivo, public;

ALTER FUNCTION embed_claim(text, integer) SECURITY DEFINER;
