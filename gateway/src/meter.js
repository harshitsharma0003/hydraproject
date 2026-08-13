'use strict';

const { pool } = require('./db');

/**
 * Per-tenant cost telemetry from the first commit. Without it you learn your
 * true gross margin per client at renewal, which is too late.
 *
 * Billing is on queries for v1, but the attribution chain is emitted anyway so
 * switching to performance pricing later is a pricing-page change rather than a
 * re-instrumentation project.
 */

/**
 * USD micros per token. Verified against published rates, August 2026:
 *   Haiku 4.5   $1 / $5   per MTok  -> 1.0 / 5.0 micros per token
 *   Sonnet 5    $2 / $10  per MTok  (introductory; $3/$15 from 1 Sep 2026)
 *   Cache reads 10% of base input
 * Update narration_input/output after the September rate change.
 */
const PRICE_MICROS = {
  intent_input: 1.0,
  intent_cached_input: 0.1,
  intent_output: 5.0,
  narration_input: 2.0,
  narration_cached_input: 0.2,
  narration_output: 10.0,
  embed: 0.06
};

async function record(tenantId, siteId, { cached, usage, embedTokens,
                                          environment = 'production',
                                          billable = true, degraded = false }) {
  const period = new Date();
  period.setDate(1);

  // Cached reads are the dominant input volume and cost a tenth of base rate,
  // so counting them separately is the difference between a real margin figure
  // and a wildly pessimistic one.
  const cost = usage
    ? (usage.cache_read_input_tokens || 0) * PRICE_MICROS.intent_cached_input +
      (usage.input_tokens || 0) * PRICE_MICROS.intent_input +
      (usage.output_tokens || 0) * PRICE_MICROS.intent_output +
      (embedTokens || 0) * PRICE_MICROS.embed
    : 0;

  await pool.query(
    `INSERT INTO usage_meter (tenant_id, site_id, period, environment, billable,
                              queries_total, queries_cached, degraded_queries,
                              input_tokens, output_tokens, embed_tokens, cost_micros)
     VALUES ($1,$2,$3,$9,$10,1,$4,$11,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, site_id, period, environment) DO UPDATE SET
        queries_total  = usage_meter.queries_total + 1,
        queries_cached = usage_meter.queries_cached + EXCLUDED.queries_cached,
        degraded_queries = usage_meter.degraded_queries + EXCLUDED.degraded_queries,
        input_tokens   = usage_meter.input_tokens + EXCLUDED.input_tokens,
        output_tokens  = usage_meter.output_tokens + EXCLUDED.output_tokens,
        embed_tokens   = usage_meter.embed_tokens + EXCLUDED.embed_tokens,
        cost_micros    = usage_meter.cost_micros + EXCLUDED.cost_micros`,
    [tenantId, siteId, period.toISOString().slice(0, 10),
     cached ? 1 : 0, usage?.input_tokens || 0, usage?.output_tokens || 0,
     embedTokens || 0, Math.round(cost),
     environment, billable, degraded ? 1 : 0]);
}

/**
 * Soft cap. Exceeding quota degrades to native search and emails the merchant.
 * Hard cutoffs cause outages, which is a worse outcome than an overage invoice.
 */
async function overQuota(tenantId, quota, overageAllowed) {
  if (overageAllowed) return false;
  const period = new Date(); period.setDate(1);
  const { rows } = await pool.query(
    `SELECT sum(queries_total) AS n FROM usage_meter
      WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period.toISOString().slice(0, 10)]);
  return Number(rows[0]?.n || 0) >= quota;
}

module.exports = { record, overQuota };
