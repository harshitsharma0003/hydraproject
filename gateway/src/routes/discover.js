'use strict';

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { renderTaxonomy } = require('../intent');

const router = express.Router();

/**
 * Auto-discovery intake.
 *
 * This is what makes the product an appliance: the merchant configures nothing
 * but a key, and the storefront tells us what it looks like. Every field here
 * has a manual override on the storefront side.
 */
router.post('/discover', versionGate, requireKey('secret'), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.hydra;
  const p = req.body || {};

  await pool.query(
    `UPDATE sites SET locales=$1, currencies=$2, default_locale=$3,
            tile_template=$4, search_contested=$5, cartridge_version=$6,
            render_mode = CASE WHEN $5 THEN 'route_only'::render_mode
                               ELSE render_mode END
      WHERE id=$7`,
    [p.locales || [], p.currencies || [], p.defaultLocale || 'en',
     p.tileTemplate || null, !!p.searchContested, p.cartridgeVersion || null, siteId]);

  const locale = p.defaultLocale || 'en';
  const profileBody = {
    refinements: p.refinements || {},
    category_tree: p.categoryTree || [],
    price_bands: p.priceBands || {},
    has_giftcard: !!p.hasGiftcard,
    has_giftwrap: !!p.hasGiftwrap
  };

  const promptHash = crypto.createHash('sha256')
    .update(renderTaxonomy(profileBody)).digest('hex');

  const { rows: prev } = await pool.query(
    `SELECT max(version) AS v FROM taxonomy_profiles WHERE site_id=$1 AND locale=$2`,
    [siteId, locale]);
  const version = (prev[0]?.v || 0) + 1;

  await pool.query(
    `INSERT INTO taxonomy_profiles (site_id, locale, version, refinements,
        category_tree, price_bands, has_giftcard, has_giftwrap, prompt_hash)
     VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9)`,
    [siteId, locale, version,
     JSON.stringify(profileBody.refinements),
     JSON.stringify(profileBody.category_tree),
     JSON.stringify(profileBody.price_bands),
     profileBody.has_giftcard, profileBody.has_giftwrap, promptHash]);

  const mapped = Object.values(profileBody.refinements)
    .filter((d) => d.values && d.values.length).length;
  const total = Object.keys(profileBody.refinements).length;

  const findings = {
    attributesFound: total,
    attributesMapped: mapped,
    attributesNeedingReview: total - mapped,
    categoriesFound: countNodes(profileBody.category_tree),
    searchContested: !!p.searchContested,
    recommendedMode: p.searchContested ? 'route_only' : 'hijack'
  };

  await pool.query(
    `INSERT INTO health_reports (site_id, detected_mode, findings)
     VALUES ($1,$2,$3::jsonb)`,
    [siteId, findings.recommendedMode, JSON.stringify(findings)]);

  res.json({ ok: true, version, promptHash, findings });
});

function countNodes(nodes) {
  return (nodes || []).reduce((n, x) => n + 1 + countNodes(x.children), 0);
}

module.exports = router;
