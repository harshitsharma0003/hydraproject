'use strict';

const express = require('express');
const { pool, withTenant } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { MODEL } = require('../embeddings');

const router = express.Router();

/**
 * Catalog ingest.
 *
 * The content hash is the cost control. Only rows whose embeddable text changed
 * get re-embedded; in a live catalog that is 1-3% per day. Price and inventory
 * changes never touch the vector.
 */
router.post('/sync', versionGate, requireKey('secret'), async (req, res) => {
  const { tenant_id: tenantId, site_id: siteId } = req.algivo;
  const { mode, rows = [], ids = [], final } = req.body || {};

  if (mode === 'purge') {
    await withTenant(tenantId, (c) =>
      c.query('DELETE FROM products WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]));
    return res.json({ ok: true, purged: true });
  }

  if (mode === 'delete' && ids.length) {
    await withTenant(tenantId, (c) => c.query(
      'DELETE FROM products WHERE tenant_id=$1 AND site_id=$2 AND master_id = ANY($3)',
      [tenantId, siteId, ids]));
    return res.json({ ok: true, deleted: ids.length });
  }

  if (!rows.length && !final) return res.json({ ok: true, ingested: 0 });

  const result = await withTenant(tenantId, async (client) => {
    // Which rows actually need embedding?
    const incoming = rows.map((r) => ({ ...r, locale: r.locale || 'en' }));
    const existing = new Map();

    if (incoming.length) {
      const { rows: known } = await client.query(
        `SELECT master_id, locale, content_hash, embed_model
           FROM products
          WHERE tenant_id=$1 AND site_id=$2
            AND master_id = ANY($3)`,
        [tenantId, siteId, incoming.map((r) => r.masterId)]);
      known.forEach((k) => existing.set(`${k.master_id}|${k.locale}`, k));
    }

    const needsEmbed = incoming.filter((r) => {
      const prev = existing.get(`${r.masterId}|${r.locale}`);
      return !prev || prev.content_hash !== r.contentHash || prev.embed_model !== MODEL;
    });

    // Embedding no longer happens here. It used to, which made each batch take
    // 5-10s and turned a large catalog into ~53 minutes of held-open HTTP
    // connections with no resumability. Changed rows are queued instead and a
    // background worker fills them in, so this request returns in ~100ms.
    for (const r of incoming) {
      await client.query(
        `INSERT INTO products (tenant_id, site_id, master_id, locale, title,
            description, brand, category_path, attrs, colors, sizes,
            variant_count, list_price, currency, online, in_stock_hint,
            content_hash, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,now())
         ON CONFLICT (tenant_id, site_id, master_id, locale) DO UPDATE SET
            title=EXCLUDED.title, description=EXCLUDED.description,
            brand=EXCLUDED.brand, category_path=EXCLUDED.category_path,
            attrs=EXCLUDED.attrs, colors=EXCLUDED.colors, sizes=EXCLUDED.sizes,
            variant_count=EXCLUDED.variant_count,
            list_price=EXCLUDED.list_price, currency=EXCLUDED.currency,
            online=EXCLUDED.online, in_stock_hint=EXCLUDED.in_stock_hint,
            content_hash=EXCLUDED.content_hash,
            updated_at=now()`,
        [tenantId, siteId, r.masterId, r.locale, r.title, r.description || '',
         r.brand || null, r.categoryPath || [], JSON.stringify(r.attrs || {}),
         r.colors || [], r.sizes || [], r.variantCount || 1,
         r.listPrice, r.currency || null, r.online !== false,
         r.inStockHint !== false, r.contentHash]);
    }

    // Queue only what changed. The existing vector stays live and searchable
    // until the worker replaces it, so a resync never blanks the index.
    for (const r of needsEmbed) {
      await client.query(
        `INSERT INTO embed_queue (tenant_id, site_id, master_id, locale, text_to_embed)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, site_id, master_id, locale) DO UPDATE
           SET text_to_embed = EXCLUDED.text_to_embed,
               attempts = 0, claimed_at = NULL, error = NULL`,
        [tenantId, siteId, r.masterId, r.locale, embeddableText(r)]);
    }

    return { ingested: incoming.length, embedded: needsEmbed.length };
  });

  if (final) {
    // sync_runs is RLS-scoped - a plain pool insert has no tenant context and
    // is rejected by tenant_isolation, so the sync completes but is never
    // recorded (console Syncs page stays empty). withTenant.
    await withTenant(tenantId, (c) => c.query(
      `INSERT INTO sync_runs (tenant_id, site_id, kind, status, rows_seen,
                              rows_embedded, finished_at)
       VALUES ($1,$2,$3,'ok',$4,$5,now())`,
      [tenantId, siteId, mode || 'full', result.ingested, result.embedded]));
    // Taxonomy or catalog changed - stale cached queries must not survive.
    await withTenant(tenantId, (c) => c.query(
      'DELETE FROM query_cache WHERE tenant_id=$1 AND site_id=$2', [tenantId, siteId]));
  }

  res.json({ ok: true, ...result });
});

function embeddableText(r) {
  return [
    r.title,
    r.brand || '',
    (r.description || '').slice(0, 1200),
    (r.categoryPath || []).join(' > '),
    Object.entries(r.attrs || {}).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('; ')
  ].filter(Boolean).join('\n');
}

module.exports = router;
