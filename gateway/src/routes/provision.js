'use strict';

const express = require('express');
const Stripe = require('stripe');
const { pool } = require('../db');
const { issueKey } = require('../auth');

const router = express.Router();
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Creates a tenant, license, site and both keys in one transaction.
 * Shared by the Stripe webhook (SFCC purchases) and Shopify OAuth install.
 */
async function provision({ name, platform, externalSiteId, tier = 'starter',
                           environment = 'production',
                           stripeCustomerId = null, stripeSubId = null,
                           allowedOrigins = [], issueKeys = true }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [tenant] } = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name]);

    // Every tier needs a quota. 'trial' was missing here, so a signup passed
    // undefined -> NULL into a NOT NULL column and the whole request 500'd (a
    // 502 at the proxy). The `|| 100000` fallback means an unrecognised tier can
    // never reintroduce that crash.
    // Included monthly query quota per plan (Basic/Growth/Enterprise). Overage
    // is billed per query above this (₹0.50 / ₹0.35 / ₹0.25). Beyond quota the
    // storefront soft-degrades to native search rather than hard-failing.
    const quota = { trial: 1000, starter: 50000, growth: 250000,
                    enterprise: 1000000 }[tier] || 50000;
    const narration = tier === 'growth' || tier === 'enterprise';
    await client.query(
      `INSERT INTO licenses (tenant_id, tier, monthly_query_quota,
                             narration_enabled, stripe_customer_id, stripe_sub_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenant.id, tier, quota, narration, stripeCustomerId, stripeSubId]);

    const { rows: [site] } = await client.query(
      `INSERT INTO sites (tenant_id, external_site_id, platform, allowed_origins,
                          environment)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [tenant.id, externalSiteId, platform, allowedOrigins, environment]);

    // Shopify OAuth and Stripe purchases want keys issued immediately (there is
    // no console session to click "generate"). A console signup passes
    // issueKeys:false so the new user generates their own keys in the console —
    // arriving to pre-made keys you never saw is confusing and looks unfinished.
    let publishableKey = null, secretKey = null;
    if (issueKeys) {
      const pk = issueKey('publishable');
      const sk = issueKey('secret');
      for (const [k, kind] of [[pk, 'publishable'], [sk, 'secret']]) {
        await client.query(
          `INSERT INTO api_keys (tenant_id, site_id, kind, prefix, key_hash)
           VALUES ($1,$2,$3,$4,$5)`,
          [tenant.id, site.id, kind, k.prefix, k.hash]);
      }
      publishableKey = pk.full; secretKey = sk.full;
    }

    await client.query('COMMIT');
    // Full key values are returned exactly once and never stored in plaintext.
    return { tenantId: tenant.id, siteId: site.id, publishableKey, secretKey };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Shopify OAuth install. Keys are provisioned automatically - nothing to paste. */
router.post('/tenants/provision', async (req, res) => {
  const bootstrap = req.get('X-Algivo-Bootstrap');
  if (!bootstrap || bootstrap !== process.env.BOOTSTRAP_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorised' });
  }
  const { name, platform, externalSiteId, tier, allowedOrigins, environment } = req.body || {};
  if (!platform || !externalSiteId) {
    return res.status(400).json({ ok: false, error: 'missing_fields' });
  }

  const { rows: existing } = await pool.query(
    'SELECT id FROM sites WHERE external_site_id = $1 AND platform = $2',
    [externalSiteId, platform]);
  if (existing[0]) return res.json({ ok: false, error: 'already_provisioned' });

  try {
    const result = await provision({
      name: name || externalSiteId, platform, externalSiteId,
      tier: tier || 'starter', environment: environment || 'production',
      allowedOrigins: allowedOrigins || []
    });
    res.json({ ok: true, environment: environment || 'production', ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'provision_failed' });
  }
});

/**
 * Stripe webhook. SFCC customers buy online, then download the cartridge and
 * paste the keys returned here.
 */
router.post('/billing/webhook', express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (!stripe) return res.status(503).json({ ok: false });

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      return res.status(400).json({ ok: false, error: 'bad_signature' });
    }

    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;

      // Prepaid credit block: add to the ledger, no provisioning.
      if (s.metadata?.kind === 'credits') {
        const blocks = parseInt(s.metadata.blocks || '1', 10);
        await pool.query(
          `INSERT INTO credit_ledger (tenant_id, kind, queries, amount_micros,
                                      stripe_ref, note, expires_at)
           VALUES ($1,'purchase',$2,$3,$4,$5, now() + interval '12 months')`,
          [s.metadata.tenantId, blocks * 50000, s.amount_total * 10000,
           s.id, `${blocks} credit block(s)`]);
        return res.json({ received: true });
      }

      // Plan upgrade on an existing tenant: raise the quota and issue the
      // production keys that a trial deliberately does not get.
      if (s.metadata?.tenantId) {
        const tier = s.metadata.tier || 'starter';
        const quota = { starter: 50000, growth: 250000, enterprise: 1000000 }[tier];
        await pool.query(
          `UPDATE licenses SET tier=$2::license_tier, monthly_query_quota=$3,
                  included_queries=$3, narration_enabled=$4, status='active',
                  stripe_customer_id=$5, stripe_sub_id=$6
            WHERE tenant_id=$1`,
          [s.metadata.tenantId, tier, quota, tier !== 'starter',
           s.customer, s.subscription]);
        return res.json({ received: true });
      }
      const result = await provision({
        name: s.customer_details?.name || s.customer_email || 'New tenant',
        platform: s.metadata?.platform || 'sfcc_sfra',
        externalSiteId: s.metadata?.siteId || `pending-${s.id}`,
        tier: s.metadata?.tier || 'starter',
        stripeCustomerId: s.customer,
        stripeSubId: s.subscription
      });
      // Delivery of keys and the signed download link happens out of band.
      console.log('[algivo] provisioned tenant', result.tenantId);
    }

    if (event.type === 'customer.subscription.deleted') {
      await pool.query(
        `UPDATE licenses SET status='cancelled' WHERE stripe_sub_id=$1`,
        [event.data.object.id]);
    }

    if (event.type === 'invoice.payment_failed') {
      await pool.query(
        `UPDATE licenses SET status='past_due' WHERE stripe_customer_id=$1`,
        [event.data.object.customer]);
    }

    res.json({ received: true });
  });

module.exports = { router, provision };
