'use strict';

/**
 * Feature: B2B list / file upload search.
 *
 * A trade buyer uploads an order list — a screenshot, a PDF, an Excel/CSV, or a
 * pasted set of lines — and gets one product match per line, rendered by the
 * storefront as a horizontal strip of the merchant's OWN tiles.
 *
 * This is B2B ONLY. A B2C tenant (every currently onboarded client) that calls
 * it gets 403 `not_b2b`, so B2C behaviour is completely unchanged — the whole
 * feature is gated on tenants.account_type.
 *
 * The per-line match reuses the exact same pipeline as POST /v1/query
 * (loadTaxonomy -> resolveIntent -> retrieve), so a list line behaves like a
 * normal AI search. Files reach us base64-encoded inside JSON (the app-level
 * express.json 8mb limit covers screenshots and typical PDFs); Excel/CSV are
 * parsed directly, images and PDFs are read by the model.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { pool } = require('../db');
const { requireKey, versionGate } = require('../auth');
const { rateLimit } = require('../ratelimit');
const intentLib = require('../intent');
const { retrieve } = require('../retrieval');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ITEMS = parseInt(process.env.LIST_MAX_ITEMS || '25', 10);
const MATCHES_PER_LINE = 4;
const VISION_MODEL = process.env.LIST_VISION_MODEL || 'claude-sonnet-5';

// --- reused query helpers (same queries as routes/query.js) ----------------
async function loadPolicy(siteId) {
  const { rows } = await pool.query(
    `SELECT (cache_policy($1)).*, candidate_limit_for($1) AS candidate_limit`, [siteId]);
  return rows[0] || { candidate_limit: 200 };
}
async function loadTaxonomy(siteId, locale) {
  const { rows } = await pool.query(
    `SELECT * FROM taxonomy_profiles
      WHERE site_id = $1 AND locale = $2
      ORDER BY version DESC LIMIT 1`, [siteId, locale]);
  return rows[0] || null;
}

// --- B2B gate --------------------------------------------------------------
async function requireB2B(req, res, next) {
  try {
    const { rows: [t] } = await pool.query(
      'SELECT account_type FROM tenants WHERE id=$1', [req.algivo.tenant_id]);
    if (!t || t.account_type !== 'b2b') {
      return res.status(403).json({ ok: false, error: 'not_b2b' });
    }
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: 'error' });
  }
}

// --- file -> line items ----------------------------------------------------
function parseDelimited(text) {
  // CSV/TSV/pasted list. First "wordy" cell is the item, first bare integer the
  // quantity. A leading header row (qty/item/product/...) is skipped.
  const items = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cells = line.split(/[,;\t|]/).map((c) => c.trim()).filter(Boolean);
    if (!cells.length) continue;
    if (i === 0 && /^(qty|quantity|item|product|description|name|sku|no\.?)$/i.test(cells[0])) continue;
    const textCell = cells.find((c) => /[a-z]{2,}/i.test(c)) || cells[0];
    const qtyCell = cells.find((c) => /^\d{1,5}$/.test(c));
    items.push({ text: textCell, qty: qtyCell ? parseInt(qtyCell, 10) : null });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

async function extractWithModel(mediaType, dataBase64) {
  // Screenshots and PDFs: the model reads the list into structured items.
  const isPdf = mediaType === 'application/pdf';
  const media = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: dataBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: dataBase64 } };
  const msg = await anthropic.messages.create({
    model: VISION_MODEL,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        media,
        { type: 'text', text:
          'This is a shopping / order list for a trade store. Extract every line ' +
          'item. Reply with JSON ONLY, no prose: ' +
          '{"items":[{"text":"<product exactly as written>","qty":<integer or null>}]}. ' +
          `At most ${MAX_ITEMS} items.` }
      ]
    }]
  });
  const txt = (msg.content || []).map((b) => b.text || '').join('');
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try { return (JSON.parse(m[0]).items || []).slice(0, MAX_ITEMS); }
  catch { return []; }
}

async function itemsFromFile(file) {
  const { mime = '', name = '', dataBase64 = '' } = file || {};
  if (!dataBase64) return [];
  const lower = String(name).toLowerCase();
  const buf = () => Buffer.from(dataBase64, 'base64');

  // CSV / TSV / plain text.
  if (mime.startsWith('text/') || /\.(csv|tsv|txt)$/.test(lower)) {
    return parseDelimited(buf().toString('utf8'));
  }
  // Excel (.xlsx). exceljs is maintained; we flatten sheet 1 to CSV text and
  // reuse the same delimited parser.
  if (/\.(xlsx|xlsm)$/.test(lower) || mime.includes('spreadsheet') || mime.includes('officedocument')) {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf());
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const lines = [];
    ws.eachRow((row) => {
      const vals = (row.values || []).slice(1)
        .map((v) => (v == null ? '' : (v.text || v.result || v).toString()));
      lines.push(vals.join(','));
    });
    return parseDelimited(lines.join('\n'));
  }
  // Image / PDF -> model.
  if (mime.startsWith('image/') || mime === 'application/pdf' ||
      /\.(png|jpe?g|webp|gif|pdf)$/.test(lower)) {
    const mt = mime.startsWith('image/') || mime === 'application/pdf' ? mime
      : /\.pdf$/.test(lower) ? 'application/pdf'
      : /\.png$/.test(lower) ? 'image/png'
      : /\.webp$/.test(lower) ? 'image/webp' : 'image/jpeg';
    return extractWithModel(mt, dataBase64);
  }
  return [];
}

// --- per-line product match (same pipeline as /v1/query) -------------------
async function matchLine({ tenantId, siteId, locale, profile, policy, currency }, text) {
  let parsed;
  try {
    parsed = await intentLib.resolveIntent(anthropic, {
      query: text,
      profile: profile ? {
        refinements: profile.refinements,
        category_tree: profile.category_tree,
        price_bands: profile.price_bands,
        has_giftcard: profile.has_giftcard,
        has_giftwrap: profile.has_giftwrap
      } : null,
      priorIntent: null,
      currency: currency || 'USD'
    });
  } catch (e) { return []; }
  if (!parsed || !parsed.intent) return [];
  try {
    const r = await retrieve({
      tenantId, siteId, locale, intent: parsed.intent, queryText: text,
      candidateLimit: policy.candidate_limit
    });
    return (r.masterIds || []).slice(0, MATCHES_PER_LINE);
  } catch (e) { return []; }
}

router.post('/list-search', versionGate, requireKey('publishable'), requireB2B, rateLimit,
  async (req, res) => {
    try {
      const { tenant_id: tenantId, site_id: siteId } = req.algivo;
      const locale = (req.body.locale || 'en').toString();
      const currency = req.body.currency || null;

      // Collect line items: an explicit array wins; otherwise read the file.
      let items = Array.isArray(req.body.items) ? req.body.items : null;
      if (!items && req.body.file) items = await itemsFromFile(req.body.file);
      if (!items || !items.length) return res.json({ ok: false, error: 'no_items' });

      const clean = items
        .map((it) => ({
          text: String(it.text || it.name || '').trim().slice(0, 200),
          qty: Number.isFinite(it.qty) ? it.qty : (parseInt(it.qty, 10) || null)
        }))
        .filter((it) => it.text)
        .slice(0, MAX_ITEMS);
      if (!clean.length) return res.json({ ok: false, error: 'no_items' });

      const profile = await loadTaxonomy(siteId, locale);
      if (!profile) return res.json({ ok: false, error: 'not_synced' });
      const policy = await loadPolicy(siteId);

      // Run lines sequentially — bounded, predictable model spend per upload.
      const out = [];
      for (const it of clean) {
        const productIds = await matchLine(
          { tenantId, siteId, locale, profile, policy, currency }, it.text);
        out.push({ text: it.text, qty: it.qty, productIds });
      }

      res.json({ ok: true, count: out.length, items: out });
    } catch (e) {
      if (!res.headersSent) res.json({ ok: false, error: 'error' });
    }
  });

module.exports = router;
