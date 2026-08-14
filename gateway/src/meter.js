'use strict';

const { pool, withTenant } = require('./db');
const mailer = require('./mailer');
const rid = require('./requestid');

/**
 * Per-tenant cost telemetry from the first commit. Without it you learn your
 * true gross margin per client at renewal, which is too late.
 *
 * Billing is on queries for v1, but the attribution chain is emitted anyway so
 * switching to performance pricing later is a pricing-page change rather than a
 * re-instrumentation project.
 *
 * RLS NOTE: usage_meter (and licenses/tenants) have FORCE ROW LEVEL SECURITY
 * with tenant_isolation `USING (tenant_id = current_tenant())` and no WITH
 * CHECK, so the USING expression also governs INSERT. A plain pool connection
 * has no tenant context, so current_tenant() is null, tenant_id = null is null,
 * and every insert/select is rejected/empty - silently, because callers
 * fire-and-forget. Every query here therefore runs inside withTenant(tenantId),
 * which sets algivo.tenant_id for the transaction. Same class of bug as the
 * 0010 embed_claim SECURITY DEFINER fix.
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

  // withTenant: usage_meter is under RLS - a plain pool insert has no tenant
  // context and is rejected by tenant_isolation, silently (callers .catch()).
  await withTenant(tenantId, (c) => c.query(
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
     environment, billable, degraded ? 1 : 0]));

  // Only production counts toward the quota the merchant pays for.
  if (billable) checkThresholds(tenantId, siteId).catch(() => {});
}

/**
 * Soft cap. Exceeding quota degrades to native search and emails the merchant.
 * Hard cutoffs cause outages, which is a worse outcome than an overage invoice.
 */
async function overQuota(tenantId, quota, overageAllowed) {
  if (overageAllowed) return false;
  const period = new Date(); period.setDate(1);
  // withTenant: without tenant context RLS filters usage_meter to zero rows, so
  // a plain pool read here would always report "under quota".
  const { rows } = await withTenant(tenantId, (c) => c.query(
    `SELECT sum(queries_total) AS n FROM usage_meter
      WHERE tenant_id = $1 AND period = $2`,
    [tenantId, period.toISOString().slice(0, 10)]));
  return Number(rows[0]?.n || 0) >= quota;
}

/**
 * Fires once per threshold per period. Without the warned_80/warned_100 flags
 * this would email on every request after the line is crossed.
 */
async function checkThresholds(tenantId, siteId) {
  const period = new Date(); period.setDate(1);
  const p = period.toISOString().slice(0, 10);

  // withTenant: licenses/tenants/usage_meter are all RLS-scoped.
  const { rows: [row] } = await withTenant(tenantId, (c) => c.query(
    `SELECT l.monthly_query_quota AS cap, t.contact_email, t.company,
            COALESCE(sum(m.queries_total) FILTER (WHERE m.billable),0) AS used,
            bool_or(m.warned_80) AS w80, bool_or(m.warned_100) AS w100
       FROM licenses l
       JOIN tenants t ON t.id = l.tenant_id
       LEFT JOIN usage_meter m ON m.tenant_id = l.tenant_id AND m.period = $2
      WHERE l.tenant_id = $1 AND l.status = 'active'
      GROUP BY l.monthly_query_quota, t.contact_email, t.company`, [tenantId, p]));

  if (!row?.cap || !row.contact_email) return;
  const pct = Math.round(100 * Number(row.used) / Number(row.cap));

  const fire = async (col, threshold) => {
    await mailer.send('quota_warning', row.contact_email, {
      pct: threshold, used: Number(row.used), cap: Number(row.cap),
      company: row.company || 'Your account'
    }, { tenantId });
    await withTenant(tenantId, (c) => c.query(
      `UPDATE usage_meter SET ${col} = true WHERE tenant_id=$1 AND period=$2`,
      [tenantId, p]));
    rid.info('quota.warned', { tenantId, threshold });
  };

  if (pct >= 100 && !row.w100) await fire('warned_100', 100);
  else if (pct >= 80 && !row.w80) await fire('warned_80', 80);
}

module.exports = { record, overQuota, checkThresholds };
