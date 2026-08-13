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

const PRICE_MICROS = {
  intent_input: 1,      // placeholder rates - set from your actual contract
  intent_output: 5,
  narration_input: 3,
  narration_output: 15,
  embed: 0.02
};

async function record(tenantId, siteId, { cached, usage, embedTokens }) {
  const period = new Date();
  period.setDate(1);

  const cost = usage
    ? (usage.input_tokens || 0) * PRICE_MICROS.intent_input +
      (usage.output_tokens || 0) * PRICE_MICROS.intent_output +
      (embedTokens || 0) * PRICE_MICROS.embed
    : 0;

  await pool.query(
    `INSERT INTO usage_meter (tenant_id, site_id, period, queries_total,
                              queries_cached, input_tokens, output_tokens,
                              embed_tokens, cost_micros)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, site_id, period) DO UPDATE SET
        queries_total  = usage_meter.queries_total + 1,
        queries_cached = usage_meter.queries_cached + EXCLUDED.queries_cached,
        input_tokens   = usage_meter.input_tokens + EXCLUDED.input_tokens,
        output_tokens  = usage_meter.output_tokens + EXCLUDED.output_tokens,
        embed_tokens   = usage_meter.embed_tokens + EXCLUDED.embed_tokens,
        cost_micros    = usage_meter.cost_micros + EXCLUDED.cost_micros`,
    [tenantId, siteId, period.toISOString().slice(0, 10),
     cached ? 1 : 0, usage?.input_tokens || 0, usage?.output_tokens || 0,
     embedTokens || 0, Math.round(cost)]);
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
