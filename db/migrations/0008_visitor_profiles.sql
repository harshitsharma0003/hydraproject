-- ============================================================================
-- Algivo 0008 — visitor profiles
--
-- Personalisation from on-site behaviour. No third-party data is involved and
-- none is available: Instagram's Basic Display API was shut down in December
-- 2024 with no successor for personal accounts, and Google and Facebook sign-in
-- return an email address, not interests.
--
-- What is actually predictive is already being collected: which products a
-- shopper opens, which chips they click, what they search. A style vector built
-- from clicked product embeddings is a far stronger signal than anything a
-- social profile would have given.
--
-- Recency weighting matters. Someone who bought winter coats in December should
-- not still be ranked toward wool in June, so clicks decay with a half-life.
-- ============================================================================

SET search_path = algivo, public;

ALTER TABLE visitor_profiles
    ADD COLUMN IF NOT EXISTS click_count   integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_event_at timestamptz,
    ADD COLUMN IF NOT EXISTS computed_at   timestamptz;

CREATE INDEX IF NOT EXISTS visitor_profiles_stale
    ON visitor_profiles (updated_at)
    WHERE style_vector IS NOT NULL;

-- Which visitors have new activity since their profile was last computed?
CREATE OR REPLACE FUNCTION profiles_needing_refresh(p_limit integer DEFAULT 500)
RETURNS TABLE (tenant_id uuid, visitor_id uuid, events bigint)
LANGUAGE sql STABLE AS $$
    SELECT e.tenant_id, e.visitor_id, count(*)
      FROM visitor_events e
      LEFT JOIN visitor_profiles p
             ON p.tenant_id = e.tenant_id AND p.visitor_id = e.visitor_id
     WHERE e.kind IN ('click', 'add_to_cart', 'order')
       AND e.occurred_at > now() - interval '90 days'
       AND (p.computed_at IS NULL OR e.occurred_at > p.computed_at)
     GROUP BY 1, 2
    HAVING count(*) >= 3          -- below this there is nothing to learn
     LIMIT p_limit;
$$;

/**
 * Recompute one visitor's profile.
 *
 * The style vector is a recency-weighted mean of the embeddings of products
 * they engaged with. add_to_cart counts for more than a click, because opening
 * a product is curiosity and adding it is intent.
 *
 * Half-life is 30 days: a click from two months ago carries a quarter of the
 * weight of one from today.
 */
CREATE OR REPLACE FUNCTION compute_visitor_profile(p_tenant uuid, p_visitor uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    v_vec        halfvec(1024);
    v_clicks     integer;
    v_last       timestamptz;
    v_price      jsonb;
    v_attrs      jsonb;
    v_sizes      jsonb;
BEGIN
    -- Weighted mean. pgvector has no weighted aggregate, so weight is applied
    -- by repeating rows: an add_to_cart within the last week contributes ~6
    -- copies, a click from 60 days ago contributes 1.
    WITH engaged AS (
        SELECT e.master_id,
               greatest(1, round(
                   (CASE e.kind WHEN 'order' THEN 5.0
                                WHEN 'add_to_cart' THEN 3.0
                                ELSE 1.0 END)
                 * power(0.5, extract(epoch FROM now() - e.occurred_at) / (30*86400))
                 * 2
               ))::integer AS weight,
               e.occurred_at
          FROM visitor_events e
         WHERE e.tenant_id = p_tenant AND e.visitor_id = p_visitor
           AND e.kind IN ('click','add_to_cart','order')
           AND e.master_id IS NOT NULL
           AND e.occurred_at > now() - interval '90 days'
    ),
    expanded AS (
        SELECT p.embedding, p.attrs, p.list_price, p.sizes
          FROM engaged g
          JOIN products p ON p.master_id = g.master_id AND p.tenant_id = p_tenant
          CROSS JOIN generate_series(1, g.weight)
         WHERE p.embedding IS NOT NULL
    )
    SELECT avg(embedding)::halfvec INTO v_vec FROM expanded;

    SELECT count(*), max(occurred_at) INTO v_clicks, v_last
      FROM visitor_events
     WHERE tenant_id = p_tenant AND visitor_id = p_visitor
       AND kind IN ('click','add_to_cart','order');

    -- Price band they actually engage with, not what they searched for.
    SELECT jsonb_build_object(
             'p25', percentile_cont(0.25) WITHIN GROUP (ORDER BY p.list_price),
             'p50', percentile_cont(0.50) WITHIN GROUP (ORDER BY p.list_price),
             'p75', percentile_cont(0.75) WITHIN GROUP (ORDER BY p.list_price))
      INTO v_price
      FROM visitor_events e
      JOIN products p ON p.master_id = e.master_id AND p.tenant_id = p_tenant
     WHERE e.tenant_id = p_tenant AND e.visitor_id = p_visitor
       AND e.kind IN ('click','add_to_cart','order') AND p.list_price IS NOT NULL;

    -- Attribute leanings, most engaged first.
    SELECT COALESCE(jsonb_object_agg(dim, vals), '{}'::jsonb) INTO v_attrs
      FROM (
        SELECT a.key AS dim, jsonb_agg(v.value ORDER BY v.n DESC) AS vals
          FROM (
            SELECT attr.key, val.value, count(*) AS n
              FROM visitor_events e
              JOIN products p ON p.master_id = e.master_id AND p.tenant_id = p_tenant
              CROSS JOIN LATERAL jsonb_each(p.attrs) AS attr(key, arr)
              CROSS JOIN LATERAL jsonb_array_elements_text(arr) AS val(value)
             WHERE e.tenant_id = p_tenant AND e.visitor_id = p_visitor
               AND e.kind IN ('click','add_to_cart','order')
             GROUP BY 1, 2
            HAVING count(*) >= 2
          ) v(key, value, n)
          JOIN LATERAL (SELECT v.key) a(key) ON true
         GROUP BY a.key
      ) t;

    SELECT COALESCE(jsonb_agg(DISTINCT s), '[]'::jsonb) INTO v_sizes
      FROM visitor_events e
      JOIN products p ON p.master_id = e.master_id AND p.tenant_id = p_tenant
      CROSS JOIN LATERAL unnest(p.sizes) AS s
     WHERE e.tenant_id = p_tenant AND e.visitor_id = p_visitor
       AND e.kind IN ('add_to_cart','order');

    INSERT INTO visitor_profiles (tenant_id, visitor_id, style_vector,
                                  price_affinity, attr_affinity, size_hints,
                                  event_count, click_count, last_event_at,
                                  computed_at, updated_at)
    VALUES (p_tenant, p_visitor, v_vec,
            COALESCE(v_price,'{}'::jsonb), COALESCE(v_attrs,'{}'::jsonb),
            COALESCE(v_sizes,'[]'::jsonb),
            COALESCE(v_clicks,0), COALESCE(v_clicks,0), v_last, now(), now())
    ON CONFLICT (tenant_id, visitor_id) DO UPDATE SET
        style_vector   = EXCLUDED.style_vector,
        price_affinity = EXCLUDED.price_affinity,
        attr_affinity  = EXCLUDED.attr_affinity,
        size_hints     = EXCLUDED.size_hints,
        event_count    = EXCLUDED.event_count,
        click_count    = EXCLUDED.click_count,
        last_event_at  = EXCLUDED.last_event_at,
        computed_at    = now(),
        updated_at     = now();
END $$;

/**
 * Blend a shopper's style vector into a query vector.
 *
 * Weight is capped low on purpose. Personalisation that overrides what someone
 * just typed is worse than none - if they search "linen shirts" they want linen
 * shirts, not whatever they browsed last week. This nudges ordering within the
 * result set rather than changing what is in it.
 */
-- pgvector has no scalar multiply - '*' is elementwise vector * vector - so
-- scaling is done by multiplying against a constant vector.
CREATE OR REPLACE FUNCTION blend_style(
    p_query halfvec(1024), p_style halfvec(1024), p_weight real DEFAULT 0.15)
RETURNS halfvec(1024) LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_style IS NULL THEN p_query
        ELSE (
            (p_query::vector * array_fill((1 - p_weight)::real, ARRAY[1024])::vector)
          + (p_style::vector * array_fill(p_weight,           ARRAY[1024])::vector)
        )::halfvec
    END;
$$;

-- Erasure must clear the derived profile too, not just the raw events.
CREATE OR REPLACE FUNCTION algivo_forget(p_tenant uuid, p_visitor uuid)
RETURNS void LANGUAGE sql AS $$
    DELETE FROM visitor_events   WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
    DELETE FROM visitor_profiles WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
    DELETE FROM visitors         WHERE tenant_id = p_tenant AND visitor_id = p_visitor;
$$;
