'use strict';

const { withTenant } = require('./db');

/**
 * Turn the parser's suggested dimensions into real chips.
 *
 * The model picks WHICH attribute to refine on; the values come from counting
 * the products actually retrieved. That ordering matters: a model-invented chip
 * like "Petite" on a catalog with no petite products produces an empty grid on
 * click, which is worse than showing no chip at all.
 *
 * Every chip here is guaranteed to return at least MIN_HITS products.
 */

const MIN_HITS = 3;
const MAX_VALUES = 5;

async function buildChips({ tenantId, siteId, locale, masterIds, intent }) {
  const dims = intent.chipDimensions || [];
  if (!dims.length || !masterIds.length) return [];

  const rows = await withTenant(tenantId, (c) => c.query(
    `SELECT attr.key AS dimension, val.value AS value, count(*)::int AS hits
       FROM products p
       CROSS JOIN LATERAL jsonb_each(p.attrs) AS attr(key, value_arr)
       CROSS JOIN LATERAL jsonb_array_elements_text(attr.value_arr) AS val(value)
      WHERE p.tenant_id = $1 AND p.site_id = $2 AND p.locale = $3
        AND p.master_id = ANY($4)
        AND attr.key = ANY($5)
      GROUP BY 1, 2
      HAVING count(*) >= $6
      ORDER BY 1, 3 DESC`,
    [tenantId, siteId, locale, masterIds, dims, MIN_HITS]));

  // Preserve the model's ordering of dimensions - it ranked them by usefulness.
  const byDim = new Map();
  for (const r of rows.rows) {
    if (!byDim.has(r.dimension)) byDim.set(r.dimension, []);
    byDim.get(r.dimension).push(r);
  }

  const chips = [];
  for (const dim of dims) {
    const values = (byDim.get(dim) || []).slice(0, MAX_VALUES);
    // A single value is not a refinement - everything already matches it.
    if (values.length < 2) continue;
    for (const v of values) {
      chips.push({
        dimension: dim,
        value: v.value,
        label: humanise(v.value),
        hits: v.hits
      });
    }
    // One dimension's worth of chips is enough for a single row.
    if (chips.length >= MAX_VALUES) break;
  }

  return chips.slice(0, MAX_VALUES);
}

const humanise = (v) => String(v)
  .replace(/[_-]+/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());

module.exports = { buildChips, MIN_HITS };
