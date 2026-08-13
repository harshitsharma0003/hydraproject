'use strict';

const express = require('express');
const Stripe = require('stripe');
const { pool, withTenant } = require('../db');
const { issueKey } = require('../auth');
const { provision } = require('./provision');

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const PLANS = {
  trial:      { fee: 0,          included: 0,       label: 'Trial' },
  starter:    { fee: 18000000000, included: 40000,  label: 'Starter' },
  growth:     { fee: 65000000000, included: 250000, label: 'Growth' },
  enterprise: { fee: 225000000000, included: 1000000, label: 'Enterprise' }
};

const rbac = require('../rbac');
const mailer = require('../mailer');
const requireConsole = rbac.authenticate;

/* ------------------------------------------------------------------ *
 * Signup — creates a trial tenant with a sandbox only.
 * Production keys are not issued until a card is on file, which means
 * nobody can accidentally run a live storefront on an unpaid account.
 * ------------------------------------------------------------------ */

router.post('/signup', async (req, res) => {
  const { email, password, company, platform = 'sfcc_sfra', country = 'IN' } = req.body || {};
  if (!email || !password || password.length < 10) {
    return res.status(400).json({ ok: false, error: 'weak_password' });
  }

  const { rows: dup } = await pool.query(
    'SELECT 1 FROM console_users WHERE email = $1', [email]);
  if (dup.length) return res.status(409).json({ ok: false, error: 'email_taken' });

  const result = await provision({
    name: company || email,
    platform,
    externalSiteId: `sandbox-${Date.now()}`,
    tier: 'trial',
    environment: 'sandbox'
  });

  await pool.query(
    `UPDATE tenants SET contact_email=$2, company=$3, country=$4 WHERE id=$1`,
    [result.tenantId, email, company || null, country]);

  await pool.query(
    `INSERT INTO console_users (tenant_id, email, password_hash, role, name)
     VALUES ($1,$2,crypt($3, gen_salt('bf')),'owner',$4)`,
    [result.tenantId, email, password, company || null]);

  const { rows: [u] } = await pool.query(
    'SELECT id FROM console_users WHERE tenant_id=$1 AND email=$2',
    [result.tenantId, email]);
  const token = rbac.issueToken(u.id);

  // Best-effort only. A welcome email must never decide whether an account got
  // created — the keys below are returned in the response regardless. Email is
  // not wired up in every environment (provider 'console' sends nothing), so we
  // swallow anything it throws instead of failing the signup.
  try {
    await mailer.send('welcome', email, {
      name: company, publishableKey: result.publishableKey
    }, { tenantId: result.tenantId });
  } catch (e) {
    console.error('[signup] welcome email failed (non-fatal):', e.message);
  }

  // Keys are returned exactly once. They are stored hashed and cannot be
  // recovered afterwards - only rotated.
  res.json({ ok: true, token, keys: {
    environment: 'sandbox',
    publishableKey: result.publishableKey,
    secretKey: result.secretKey
  }});
});

/* ------------------------------------------------------------------ *
 * Environments — what the portal tabs render
 * ------------------------------------------------------------------ */

router.get('/environments', requireConsole, rbac.require('sites:read'), async (req, res) => {
  const detail = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT * FROM environment_detail WHERE tenant_id=$1
      ORDER BY CASE environment WHEN 'production' THEN 0
                                WHEN 'uat' THEN 1 ELSE 2 END`,
    [req.user.tenant_id]));

  const keys = await pool.query(
    `SELECT k.id, k.site_id, k.kind, k.prefix, k.last4, k.label,
            k.last_used_at, k.created_at
       FROM api_keys k WHERE k.tenant_id=$1 AND k.revoked_at IS NULL
      ORDER BY k.created_at`, [req.user.tenant_id]);

  const { rows: [lic] } = await pool.query(
    `SELECT tier, included_queries, monthly_query_quota, nonprod_monthly_query_cap,
            overage_price_micros, currency, platform_fee_micros, status
       FROM licenses WHERE tenant_id=$1 AND status IN ('active','past_due')
      LIMIT 1`, [req.user.tenant_id]);

  res.json({
    ok: true,
    license: lic || null,
    environments: detail.rows.map((e) => ({
      ...e,
      keys: keys.rows.filter((k) => k.site_id === e.site_id)
        .map((k) => ({ ...k, masked: `${k.prefix}${'•'.repeat(20)}${k.last4 || ''}` }))
    }))
  });
});

/**
 * Rotate. There is no "reveal" - the stored value is a hash. The new key is
 * shown once here and never again.
 */
router.post('/keys/rotate', requireConsole, rbac.require('keys:rotate'), rbac.requireSite, async (req, res) => {
  const { siteId, kind } = req.body || {};
  const { rows: [site] } = await pool.query(
    'SELECT id FROM sites WHERE id=$1 AND tenant_id=$2', [siteId, req.user.tenant_id]);
  if (!site) return res.status(404).json({ ok: false });

  const k = issueKey(kind === 'secret' ? 'secret' : 'publishable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Old key stays valid for 24h so a rotation does not take a storefront
    // down while the merchant updates their configuration.
    await client.query(
      `UPDATE api_keys SET revoked_at = now() + interval '24 hours'
        WHERE site_id=$1 AND kind=$2 AND revoked_at IS NULL`, [siteId, kind]);
    await client.query(
      `INSERT INTO api_keys (tenant_id, site_id, kind, prefix, key_hash, last4)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.user.tenant_id, siteId, kind, k.prefix, k.hash, k.full.slice(-4)]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    return res.status(500).json({ ok: false });
  } finally { client.release(); }

  rbac.audit(req, 'keys.rotated', { targetType: 'site', targetId: siteId,
    siteId, detail: { kind } });

  res.json({ ok: true, key: k.full,
    note: 'Copy this now. It is stored hashed and cannot be shown again. '
        + 'The previous key keeps working for 24 hours.' });
});

/* ------------------------------------------------------------------ *
 * Billing
 * ------------------------------------------------------------------ */

router.get('/billing', requireConsole, rbac.require('billing:read'), async (req, res) => {
  const summary = await withTenant(req.user.tenant_id, (c) => c.query(
    `SELECT * FROM billing_summary WHERE tenant_id=$1
      ORDER BY period DESC NULLS LAST LIMIT 12`, [req.user.tenant_id]));

  const { rows: invoices } = await pool.query(
    `SELECT period, currency, total_micros, status, issued_at, paid_at
       FROM invoices WHERE tenant_id=$1 ORDER BY period DESC LIMIT 12`,
    [req.user.tenant_id]);

  const { rows: [bal] } = await pool.query(
    'SELECT credit_balance($1) AS credits', [req.user.tenant_id]);

  res.json({
    ok: true,
    summary: summary.rows,
    invoices,
    credits: Number(bal?.credits || 0),
    plans: PLANS
  });
});

/** Stripe Checkout for a plan upgrade. */
router.post('/checkout', requireConsole, rbac.require('billing:write'), async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false, error: 'billing_unavailable' });
  const { tier } = req.body || {};
  if (!PLANS[tier] || tier === 'trial') {
    return res.status(400).json({ ok: false, error: 'invalid_tier' });
  }

  const { rows: [t] } = await pool.query(
    'SELECT contact_email, company FROM tenants WHERE id=$1', [req.user.tenant_id]);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: t?.contact_email || req.user.email,
    line_items: [{ price: process.env[`STRIPE_PRICE_${tier.toUpperCase()}`], quantity: 1 }],
    success_url: `${process.env.CONSOLE_ORIGIN}/billing?upgraded=1`,
    cancel_url: `${process.env.CONSOLE_ORIGIN}/billing`,
    metadata: { tenantId: req.user.tenant_id, tier }
  });

  res.json({ ok: true, url: session.url });
});

/** Prepaid overage blocks — a purchase order, not a surprise invoice. */
router.post('/credits/purchase', requireConsole, rbac.require('billing:write'), async (req, res) => {
  if (!stripe) return res.status(503).json({ ok: false });
  const { blocks = 1 } = req.body || {};

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: process.env.STRIPE_PRICE_CREDIT_BLOCK, quantity: blocks }],
    success_url: `${process.env.CONSOLE_ORIGIN}/billing?credits=1`,
    cancel_url: `${process.env.CONSOLE_ORIGIN}/billing`,
    metadata: { tenantId: req.user.tenant_id, kind: 'credits', blocks: String(blocks) }
  });

  res.json({ ok: true, url: session.url });
});

module.exports = { router, requireConsole, PLANS };
