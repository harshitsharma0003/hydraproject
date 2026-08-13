'use strict';

const { withTenant } = require('./db');
const { embed, toPgVector } = require('./embeddings');

const CANDIDATE_LIMIT = parseInt(process.env.CANDIDATE_LIMIT || '200', 10);
const RESULT_FLOOR = parseInt(process.env.RESULT_FLOOR || '8', 10);

/**
 * The widening ladder.
 *
 * A tight budget on a sparse catalog returns zero. An empty grid on the first
 * query a prospect ever types is how you lose a deal. So we relax in a defined
 * order and stop as soon as we clear the floor - and we always tell the shopper
 * what we relaxed.
 */
const LADDER = [
  { id: 'full',        relax: (f) => f },
  { id: 'soft_signals',relax: (f) => ({ ...f, softSignals: f.softSignals.slice(0, 2) }) },
  { id: 'price_20',    relax: (f) => ({ ...f,
                          priceMax: f.priceMax ? f.priceMax * 1.2 : null }),
                        message: (f) => `Nothing under ${f.priceMax}. Showing the closest matches.` },
  { id: 'attrs',       relax: (f) => ({ ...f, attrs: pickGenderOnly(f.attrs) }),
                        message: () => 'Widened to show more options.' },
  { id: 'bare',        relax: (f) => ({ ...f, attrs: {}, categories: null, priceMax: null }),
                        message: () => 'Showing a broader selection.' }
];

function pickGenderOnly(attrs) {
  const out = {};
  for (const k of Object.keys(attrs || {})) {
    if (/gender|department|audience/i.test(k)) out[k] = attrs[k];
  }
  return out;
}

async function runRetrieval(client, tenantId, siteId, locale, f, limit) {
  // Personalisation is applied to the query vector before retrieval, so it
  // nudges ordering within the result set rather than changing what is in it.
  const vec = f.styleVector
    ? (await client.query('SELECT blend_style($1::halfvec,$2::halfvec,$3) AS v',
        [f.vector, f.styleVector, f.styleWeight || 0.15])).rows[0].v
    : f.vector;

  const { rows } = await client.query(
    `SELECT * FROM algivo_retrieve($1,$2,$3,$4::halfvec,$5,$6::jsonb,$7,$8,$9,$10)`,
    [tenantId, siteId, locale, vec, f.queryText,
     JSON.stringify(f.attrs || {}),
     f.categories && f.categories.length ? f.categories : null,
     // Band is widened here, not in SQL, so the caller controls the policy.
     f.priceMax ? f.priceMax * 1.15 : null,
     f.priceMin || null,
     CANDIDATE_LIMIT]);
  return rows;
}

/**
 * @returns {{ masterIds: string[], relaxed: object|null }}
 */
async function retrieve({ tenantId, siteId, locale, intent, queryText,
                          candidateLimit, styleVector, styleWeight }) {
  const [vector] = await embed([buildSemanticText(intent, queryText)], 'query');

  const base = {
    vector: toPgVector(vector),
    styleVector,
    styleWeight,
    queryText: queryText || '',
    attrs: intent.hardFilters || {},
    categories: intent.categories || [],
    priceMax: intent.price?.max || null,
    priceMin: intent.price?.min || null,
    softSignals: intent.softSignals || []
  };

  return withTenant(tenantId, async (client) => {
    for (const rung of LADDER) {
      const filters = rung.relax(base);
      const rows = await runRetrieval(client, tenantId, siteId, locale, filters,
                                      candidateLimit);

      if (rows.length >= RESULT_FLOOR || rung.id === 'bare') {
        return {
          masterIds: rows.map((r) => r.master_id),
          relaxed: rung.id === 'full' ? null : {
            rung: rung.id,
            message: rung.message ? rung.message(base) : 'Widened your search.'
          }
        };
      }
    }
    return { masterIds: [], relaxed: { rung: 'none', message: 'No matches found.' } };
  });
}

/**
 * Soft signals rank; hard filters filter. Only the ranking text gets embedded -
 * embedding the facet values too would double-count them.
 */
function buildSemanticText(intent, raw) {
  const parts = [raw || ''];
  if (intent.softSignals?.length) parts.push(intent.softSignals.join(', '));
  if (intent.excludes?.length) parts.push('not: ' + intent.excludes.join(', '));
  if (intent.sizeStrategy === 'avoid_size_dependent') {
    parts.push('accessory, one size, gift');
  }
  return parts.filter(Boolean).join('. ');
}

module.exports = { retrieve, LADDER, CANDIDATE_LIMIT, RESULT_FLOOR };
