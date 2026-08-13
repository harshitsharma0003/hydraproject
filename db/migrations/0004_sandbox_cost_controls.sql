-- ============================================================================
-- Algivo 0004 — environment-aware cost controls
--
-- Sandbox and UAT run real queries against real models, so without this they
-- cost the same per query as production while generating no revenue.
--
-- The lever is that testing is repetitive in a way production is not. A QA
-- suite runs the same 50-200 queries hundreds of times. Production sees a long
-- tail of genuinely new phrasings. So:
--
--   production  cache TTL 1 hour     ~70% hit rate
--   uat         cache TTL 7 days     ~95% hit rate
--   sandbox     cache never expires  ~99% after warm-up
--
-- A sandbox exercising 200 distinct queries costs about $0.44 ONCE, then
-- effectively nothing. That is a real cost reduction, not a rate adjustment.
--
-- The trade-off: a developer iterating on prompts would see stale results
-- forever. So the cache is keyed on taxonomy version (already) AND can be
-- flushed on demand from the console, and any request carrying
-- X-Algivo-No-Cache bypasses it.
-- ============================================================================

SET search_path = algivo, public;

ALTER TABLE sites
    -- NULL means "use the environment default" from cache_policy() below.
    ADD COLUMN cache_ttl_override_seconds integer,
    -- Non-production trims the taxonomy prompt: at most N values listed per
    -- refinement attribute. Cuts cached input tokens without changing shape.
    ADD COLUMN taxonomy_value_cap integer;

/**
 * Cache TTL for a site. NULL return = never expires.
 */
CREATE OR REPLACE FUNCTION cache_policy(p_site_id uuid)
RETURNS TABLE (ttl_seconds integer, permanent boolean, value_cap integer)
LANGUAGE sql STABLE AS $$
    SELECT
        COALESCE(s.cache_ttl_override_seconds,
                 CASE s.environment
                     WHEN 'production' THEN 3600
                     WHEN 'uat'        THEN 604800
                     WHEN 'sandbox'    THEN NULL
                 END),
        s.environment = 'sandbox' AND s.cache_ttl_override_seconds IS NULL,
        COALESCE(s.taxonomy_value_cap,
                 CASE s.environment
                     WHEN 'production' THEN NULL
                     ELSE 12
                 END)
      FROM sites s WHERE s.id = p_site_id;
$$;

-- Permanent cache entries need a sentinel rather than a real timestamp, so the
-- purge job does not quietly delete them.
ALTER TABLE query_cache ALTER COLUMN expires_at DROP NOT NULL;

CREATE OR REPLACE FUNCTION algivo_purge(p_days integer DEFAULT 90)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    -- NULL expires_at = permanent sandbox entry, never purged by age.
    DELETE FROM query_cache    WHERE expires_at IS NOT NULL AND expires_at < now();
    DELETE FROM query_tokens   WHERE expires_at < now();
    DELETE FROM rate_buckets   WHERE window_start < now() - interval '1 hour';
    DELETE FROM visitor_events WHERE occurred_at < now() - make_interval(days => p_days);
    DELETE FROM visitors       WHERE last_seen   < now() - make_interval(days => p_days);
    DELETE FROM ingest_jobs    WHERE completed_at < now() - interval '30 days';
    DELETE FROM products_staging s
     WHERE NOT EXISTS (SELECT 1 FROM ingest_jobs j WHERE j.id = s.job_id);
    DELETE FROM embed_queue WHERE attempts >= 5 AND created_at < now() - interval '7 days';
END $$;

/**
 * Manual flush. The console exposes this for sandbox, because a permanent
 * cache is exactly wrong while someone is iterating on prompts or catalog data.
 */
CREATE OR REPLACE FUNCTION cache_flush(p_site_id uuid)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_n bigint; v_tenant uuid;
BEGIN
    SELECT tenant_id INTO v_tenant FROM sites WHERE id = p_site_id;
    DELETE FROM query_cache WHERE tenant_id = v_tenant AND site_id = p_site_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END $$;

-- Cheaper defaults for non-production. Retrieval breadth costs database time,
-- not model spend, but a sandbox has no need for a 200-candidate funnel.
ALTER TABLE sites ADD COLUMN candidate_limit_override integer;

CREATE OR REPLACE FUNCTION candidate_limit_for(p_site_id uuid)
RETURNS integer LANGUAGE sql STABLE AS $$
    SELECT COALESCE(s.candidate_limit_override,
                    CASE s.environment WHEN 'production' THEN 200 ELSE 60 END)
      FROM sites s WHERE s.id = p_site_id;
$$;

-- Visibility: how much each environment actually costs you.
CREATE OR REPLACE VIEW environment_cost AS
SELECT m.tenant_id, s.external_site_id, m.environment, m.period,
       sum(m.queries_total)  AS queries,
       sum(m.queries_cached) AS cached,
       CASE WHEN sum(m.queries_total) > 0
            THEN round(100.0 * sum(m.queries_cached) / sum(m.queries_total), 1)
            ELSE 0 END       AS cache_hit_pct,
       sum(m.cost_micros) / 1000000.0 AS cost_usd
  FROM usage_meter m JOIN sites s ON s.id = m.site_id
 GROUP BY m.tenant_id, s.external_site_id, m.environment, m.period;
