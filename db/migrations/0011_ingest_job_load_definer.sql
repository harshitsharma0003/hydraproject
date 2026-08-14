-- ============================================================================
-- Algivo 0011 — ingest_job_load runs as owner (RLS bypass for the worker)
--
-- The ingest worker is cross-tenant: it discovers jobs by scanning the SFTP
-- drop directory on disk, so it holds a jobId but NO tenant context. It then
-- loaded the job with `SELECT * FROM ingest_jobs WHERE id=$1` on a plain
-- connection — but ingest_jobs has FORCE ROW LEVEL SECURITY with
-- tenant_isolation (tenant_id = current_tenant()). With no tenant set the row
-- was invisible, so the worker could never process an SFTP/bulk job: the job
-- was created (console showed it) but nothing ingested. Products only ever
-- landed via the /v1/sync path, which writes them in-route under withTenant.
--
-- This SECURITY DEFINER loader is owned by the migration role (postgres), which
-- bypasses RLS, so it returns the job regardless of tenant context. The worker
-- reads job.tenant_id from it and then runs every subsequent write inside that
-- tenant's context. Same shape as the 0010 embed_claim fix.
-- ============================================================================

SET search_path = algivo, public;

CREATE OR REPLACE FUNCTION ingest_job_load(p_job_id uuid)
RETURNS algivo.ingest_jobs
LANGUAGE sql
SECURITY DEFINER
SET search_path = algivo, public
AS $$
  SELECT * FROM algivo.ingest_jobs WHERE id = p_job_id;
$$;

GRANT EXECUTE ON FUNCTION ingest_job_load(uuid) TO algivo_app;
