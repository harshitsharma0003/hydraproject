'use strict';

/**
 * Shopify integration — mounted at /shopify on the SAME gateway that serves
 * SFCC. Nothing here touches /v1/* ; it only ADDS /shopify/* routes, so SFCC is
 * unaffected.
 *
 * This is the Shopify analog of the SFCC "service" model: the storefront never
 * calls the gateway directly. It calls the Shopify App Proxy
 * (/apps/algivo/query on the shop's own domain), Shopify forwards it here
 * server-side (/shopify/proxy/query), and we inject the shop's key and call the
 * gateway's /v1/query. Keys + gateway url never reach the browser.
 *
 *   OAuth:      GET  /shopify/auth  ->  GET /shopify/auth/callback
 *   Admin UI:   GET  /shopify/app   (embedded settings) + /shopify/api/*
 *   Webhooks:   POST /shopify/webhooks   (HMAC over raw body)
 *   App Proxy:  ANY  /shopify/proxy/query|event   (signature-verified)
 */

const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const rid = require('../requestid');

const router = express.Router();

const API_KEY = process.env.SHOPIFY_API_KEY || '';
const API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const SCOPES = process.env.SHOPIFY_SCOPES || 'read_products';
const APP_HOST = (process.env.SHOPIFY_APP_HOST || 'https://algivo.thinkvisor.io').replace(/\/+$/, '');
const APP_BASE = APP_HOST + '/shopify';
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-04';
const SELF = (process.env.GATEWAY_SELF_URL || ('http://127.0.0.1:' + (process.env.PORT || 8080))).replace(/\/+$/, '');

/* ── storage (plain table; not tenant-scoped) ─────────────────────────────── */
pool.query(`CREATE TABLE IF NOT EXISTS shopify_shops (
  shop              text PRIMARY KEY,
  access_token      text,
  pub_key           text NOT NULL DEFAULT '',
  secret_key        text NOT NULL DEFAULT '',
  source_collection text NOT NULL DEFAULT 'all',
  installed_at      timestamptz DEFAULT now(),
  last_sync_at      timestamptz,
  last_sync_count   integer,
  updated_at        timestamptz DEFAULT now()
)`).catch((e) => rid.error('shopify.table', { err: e && e.message }));

const getShop = (shop) => pool.query('SELECT * FROM shopify_shops WHERE shop=$1', [shop]).then((r) => r.rows[0] || null);

/* ── crypto helpers ───────────────────────────────────────────────────────── */
function tEq(a, b) {
  const ba = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function isShop(shop) { return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop || ''); }

// OAuth callback hmac: params minus hmac/signature, sorted, joined with '&'.
function validOauthHmac(q) {
  const { hmac, signature, ...rest } = q;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  return tEq(crypto.createHmac('sha256', API_SECRET).update(msg).digest('hex'), hmac);
}
// App Proxy signature: params minus signature, sorted, joined with NO delimiter.
function validProxySig(q) {
  const { signature, ...rest } = q;
  const msg = Object.keys(rest).sort().map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('');
  return signature && tEq(crypto.createHmac('sha256', API_SECRET).update(msg).digest('hex'), signature);
}
// Webhook hmac: base64 HMAC over the raw body.
function validWebhookHmac(rawBody, header) {
  return tEq(crypto.createHmac('sha256', API_SECRET).update(rawBody).digest('base64'), header);
}
// App Bridge session token (JWT HS256, signed with the app secret).
function verifySessionToken(auth) {
  const m = /^Bearer (.+)$/.exec(auth || '');
  if (!m) return null;
  const [h, p, s] = m[1].split('.');
  if (!h || !p || !s) return null;
  const expected = crypto.createHmac('sha256', API_SECRET).update(`${h}.${p}`).digest('base64url');
  if (!tEq(expected, s)) return null;
  let payload; try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (payload.exp && Date.now() / 1000 > payload.exp) return null;
  if (payload.aud !== API_KEY) return null;
  const shop = (payload.dest || '').replace(/^https?:\/\//, '');
  return isShop(shop) ? shop : null;
}

/* ── OAuth ─────────────────────────────────────────────────────────────────── */
router.get('/auth', (req, res) => {
  const shop = String(req.query.shop || '').toLowerCase();
  if (!isShop(shop)) return res.status(400).send('Missing or invalid ?shop');
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie ? res.cookie('algivo_oauth_state', state, { httpOnly: true, secure: true, sameSite: 'lax' }) : null;
  const url = `https://${shop}/admin/oauth/authorize?client_id=${API_KEY}` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(APP_BASE + '/auth/callback')}` +
    `&state=${state}`;
  res.redirect(url);
});

router.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;
  if (!isShop(shop) || !code) return res.status(400).send('Bad callback');
  if (!validOauthHmac(req.query)) return res.status(400).send('HMAC validation failed');
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: API_KEY, client_secret: API_SECRET, code })
    });
    const tok = await r.json();
    if (!tok.access_token) return res.status(400).send('Token exchange failed');

    await pool.query(
      `INSERT INTO shopify_shops (shop, access_token, updated_at)
       VALUES ($1,$2,now())
       ON CONFLICT (shop) DO UPDATE SET access_token=$2, updated_at=now()`,
      [shop, tok.access_token]);

    await registerWebhooks(shop, tok.access_token).catch((e) => rid.error('shopify.webhook_register', { err: e && e.message }));

    // Open the embedded app UI inside the Shopify admin.
    const host = req.query.host || Buffer.from(`${shop}/admin`).toString('base64');
    res.redirect(`${APP_BASE}/app?shop=${shop}&host=${host}`);
  } catch (e) {
    rid.error('shopify.oauth', { err: e && e.message });
    res.status(500).send('OAuth error');
  }
});

async function shopApi(shop, token, path, opts = {}) {
  const r = await fetch(`https://${shop}/admin/api/${API_VERSION}${path}`, {
    ...opts, headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  return r;
}

async function registerWebhooks(shop, token) {
  const topics = ['products/create', 'products/update', 'products/delete', 'app/uninstalled'];
  for (const topic of topics) {
    await shopApi(shop, token, '/webhooks.json', {
      method: 'POST',
      body: JSON.stringify({ webhook: { topic, address: APP_BASE + '/webhooks', format: 'json' } })
    }).catch(() => {});
  }
}

/* ── Webhooks (raw body; server.js skips json parsing for this path) ──────── */
router.post('/webhooks', express.raw({ type: '*/*', limit: '4mb' }), async (req, res) => {
  const raw = req.body; // Buffer
  if (!validWebhookHmac(raw, req.get('X-Shopify-Hmac-Sha256'))) return res.sendStatus(401);
  res.sendStatus(200); // ack fast; process after
  const shop = req.get('X-Shopify-Shop-Domain');
  const topic = req.get('X-Shopify-Topic');
  let body = {}; try { body = JSON.parse(raw.toString('utf8')); } catch (e) { /* */ }
  try {
    if (topic === 'products/create' || topic === 'products/update') await syncOne(shop, body.id);
    else if (topic === 'products/delete') await removeOne(shop, body.handle || body.id);
    else if (topic === 'app/uninstalled' || topic === 'shop/redact') await pool.query('DELETE FROM shopify_shops WHERE shop=$1', [shop]);
    // customers/data_request, customers/redact: nothing stored -> no-op.
  } catch (e) { rid.error('shopify.webhook', { topic, err: e && e.message }); }
});

/* ── App Proxy: storefront queries, server-side (like the SFCC service) ───── */
async function proxyForward(req, res, gatewayPath) {
  if (!validProxySig(req.query)) return res.status(401).json({ ok: false, error: 'bad_signature' });
  const shop = String(req.query.shop || '').toLowerCase();
  const s = await getShop(shop);
  if (!s || !s.pub_key) return res.status(200).json({ ok: false, error: 'not_configured' });
  const r = await fetch(`${SELF}${gatewayPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Algivo-Key': s.pub_key,
      'X-Algivo-Version': '1.0.0',
      // origin-lock check in the gateway matches the shop's storefront
      'Origin': `https://${shop}`
    },
    body: JSON.stringify(req.body || {})
  });
  const j = await r.json().catch(() => ({ ok: false }));
  res.status(200).json(j);
}
router.post('/proxy/query', (req, res) => proxyForward(req, res, '/v1/query'));
router.post('/proxy/event', (req, res) => proxyForward(req, res, '/v1/event'));

/* ── Embedded admin UI + its API (session-token auth) ─────────────────────── */
router.get('/app', (_req, res) => {
  res.set('Content-Type', 'text/html').send(SETTINGS_HTML.replace(/%API_KEY%/g, API_KEY));
});

function requireSession(req, res, next) {
  const shop = verifySessionToken(req.get('Authorization'));
  if (!shop) return res.status(401).json({ ok: false, error: 'unauthenticated' });
  req.shop = shop;
  next();
}

router.get('/api/settings', requireSession, async (req, res) => {
  const s = await getShop(req.shop) || {};
  res.json({
    shop: req.shop, pub_key: s.pub_key || '', secret_key_set: !!s.secret_key,
    source_collection: s.source_collection || 'all',
    last_sync_at: s.last_sync_at || null, last_sync_count: s.last_sync_count ?? null
  });
});

router.post('/api/settings', requireSession, async (req, res) => {
  const cur = await getShop(req.shop) || {};
  const pub = (req.body.pub_key || '').trim();
  const secret = (req.body.secret_key || '').trim() || cur.secret_key || '';
  const coll = (req.body.source_collection || 'all').trim() || 'all';
  await pool.query(
    `INSERT INTO shopify_shops (shop, pub_key, secret_key, source_collection, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (shop) DO UPDATE SET pub_key=$2, secret_key=$3, source_collection=$4, updated_at=now()`,
    [req.shop, pub, secret, coll]);
  res.json({ ok: true });
});

router.post('/api/sync', requireSession, async (req, res) => {
  try { const count = await fullSync(req.shop); res.json({ ok: true, count }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
});

/* ── Catalog sync (Admin API -> gateway /v1/sync + /v1/discover) ──────────── */
function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
function optionVals(p, names) {
  const out = [];
  (p.options || []).forEach((o) => { if (names.indexOf(String(o.name || '').toLowerCase()) !== -1) (o.values || []).forEach((v) => out.push(String(v))); });
  return out;
}
function toRow(p) {
  const desc = stripHtml(p.body_html);
  const tags = String(p.tags || '').split(',').map((s) => s.trim()).filter(Boolean);
  const colors = optionVals(p, ['color', 'colour']); const sizes = optionVals(p, ['size']);
  const prices = (p.variants || []).map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
  const inStock = (p.variants || []).some((v) => v.inventory_quantity > 0 || v.inventory_management == null || v.inventory_policy === 'continue');
  return {
    masterId: p.handle, handle: p.handle, locale: 'en', title: p.title,
    description: desc, brand: p.vendor || null,
    categoryPath: p.product_type ? [p.product_type] : [],
    attrs: { tags, productType: p.product_type || '' }, colors, sizes,
    variantCount: (p.variants || []).length || 1,
    listPrice: prices.length ? Math.min.apply(null, prices) : null,
    currency: 'USD', online: p.status === 'active', inStockHint: inStock,
    contentHash: crypto.createHash('sha256').update([p.title, desc, p.vendor, p.product_type, tags.join(',')].join('|')).digest('hex')
  };
}
function buildDiscover(rows) {
  const uniq = (a) => Array.from(new Set(a.filter(Boolean)));
  const colors = uniq(rows.flatMap((r) => r.colors)), sizes = uniq(rows.flatMap((r) => r.sizes));
  const brands = uniq(rows.map((r) => r.brand)), types = uniq(rows.map((r) => r.attrs.productType));
  const tags = uniq(rows.flatMap((r) => r.attrs.tags));
  const prices = rows.map((r) => r.listPrice).filter((n) => typeof n === 'number');
  const min = prices.length ? Math.min(...prices) : 0, max = prices.length ? Math.max(...prices) : 0;
  const step = Math.max(1, Math.round((max - min) / 4)) || 1; const bands = [];
  for (let lo = min; lo < max; lo += step) bands.push({ min: Math.round(lo), max: Math.round(Math.min(lo + step, max)) });
  return {
    locales: ['en'], currencies: ['USD'], defaultLocale: 'en',
    refinements: { color: { values: colors.slice(0, 100) }, size: { values: sizes.slice(0, 60) },
      brand: { values: brands.slice(0, 100) }, productType: { values: types.slice(0, 100) }, tags: { values: tags.slice(0, 200) } },
    categoryTree: types.slice(0, 100).map((t) => ({ id: t, label: t })), priceBands: bands, hasGiftcard: false, hasGiftwrap: false
  };
}
async function gwPost(pubOrSecret, path, body) {
  const r = await fetch(`${SELF}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Algivo-Key': pubOrSecret, 'X-Algivo-Version': '1.0.0' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`gateway ${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}
async function fullSync(shop) {
  const s = await getShop(shop);
  if (!s || !s.access_token) throw new Error('Shop not installed');
  if (!s.secret_key) throw new Error('Algivo secret key not set — add it in the app settings.');
  const rows = [];
  let url = `https://${shop}/admin/api/${API_VERSION}/products.json?limit=250`;
  while (url) {
    const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': s.access_token } });
    if (!r.ok) throw new Error('Shopify products ' + r.status);
    const j = await r.json();
    for (const p of (j.products || [])) rows.push(toRow(p));
    const m = (r.headers.get('link') || '').match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null;
  }
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    await gwPost(s.secret_key, '/v1/sync', { mode: 'full', rows: rows.slice(i, i + BATCH), final: i + BATCH >= rows.length });
  }
  if (rows.length) await gwPost(s.secret_key, '/v1/discover', buildDiscover(rows));
  await pool.query('UPDATE shopify_shops SET last_sync_at=now(), last_sync_count=$2 WHERE shop=$1', [shop, rows.length]);
  return rows.length;
}
async function syncOne(shop, productId) {
  const s = await getShop(shop); if (!s || !s.access_token || !s.secret_key) return;
  const r = await shopApi(shop, s.access_token, `/products/${productId}.json`); if (!r.ok) return;
  const p = (await r.json()).product; if (!p) return;
  await gwPost(s.secret_key, '/v1/sync', { mode: 'delta', rows: [toRow(p)], final: true });
}
async function removeOne(shop, handleOrId) {
  const s = await getShop(shop); if (!s || !s.secret_key) return;
  await gwPost(s.secret_key, '/v1/sync', { mode: 'delta', ids: [String(handleOrId)], delete: true, final: true }).catch(() => {});
}

/* ── minimal embedded settings page ───────────────────────────────────────── */
const SETTINGS_HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="shopify-api-key" content="%API_KEY%">
<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
<title>Algivo AI Search</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Inter,sans-serif;color:#1a1a1a;background:#f6f6f7;margin:0}
.w{max-width:680px;margin:0 auto;padding:28px 20px}h1{font-size:22px;margin:0 0 4px}.s{color:#6b6b70;font-size:14px;margin:0 0 20px}
.c{background:#fff;border:1px solid #e3e3e6;border-radius:12px;padding:20px;margin-bottom:16px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:10px 12px;border:1px solid #e3e3e6;border-radius:8px;font-size:14px}.h{color:#6b6b70;font-size:12px;margin-top:5px}
button{border:0;border-radius:8px;padding:10px 16px;font-weight:650;cursor:pointer}.p{background:#6D4AF2;color:#fff}.g{background:#fff;border:1px solid #e3e3e6}
.st{font-size:13px;margin-top:12px}.ok{color:#137333}.er{color:#c5221f}.row{display:flex;gap:12px;align-items:center;margin-top:16px}</style></head>
<body><div class="w"><h1>Algivo AI Search</h1><p class="s">Enter the keys from <b>algivo.thinkvisor.io → Keys</b>, then sync your catalog.</p>
<div class="c"><h3>Connection</h3>
<label>Publishable key (alg_pk_)</label><input id=pub placeholder="alg_pk_…"><div class="h">Used for storefront search.</div>
<label>Secret key (alg_sk_)</label><input id=secret placeholder="alg_sk_…  (leave blank to keep saved)"><div class="h">Server-side only; used to sync your catalog.</div>
<label>Source collection handle</label><input id=coll placeholder="all"><div class="h">Results reuse your theme's cards from this collection.</div>
<div class="row"><button class="p" id=save>Save</button><span id=ss class="st"></span></div></div>
<div class="c"><h3>Catalog sync</h3><div class="row"><button class="g" id=sync>Sync catalog now</button><span id=cs class="st"></span></div><div id=last class="h" style="margin-top:8px"></div></div></div>
<script>
const $=id=>document.getElementById(id);
async function tok(){try{return await shopify.idToken()}catch(e){return ''}}
async function api(p,o){const t=await tok();return fetch('/shopify/api'+p,Object.assign({headers:{'Content-Type':'application/json','Authorization':'Bearer '+t}},o)).then(r=>r.json())}
async function load(){try{const s=await api('/settings');$('pub').value=s.pub_key||'';$('coll').value=s.source_collection||'all';if(s.secret_key_set)$('secret').placeholder='alg_sk_…  (saved — leave blank to keep)';if(s.last_sync_at)$('last').textContent='Last sync: '+(s.last_sync_count??'?')+' products · '+new Date(s.last_sync_at).toLocaleString()}catch(e){$('ss').textContent='Load failed: '+e.message;$('ss').className='st er'}}
$('save').onclick=async()=>{$('ss').textContent='Saving…';$('ss').className='st';try{await api('/settings',{method:'POST',body:JSON.stringify({pub_key:$('pub').value.trim(),secret_key:$('secret').value.trim(),source_collection:($('coll').value.trim()||'all')})});$('secret').value='';$('ss').textContent='Saved.';$('ss').className='st ok'}catch(e){$('ss').textContent='Save failed: '+e.message;$('ss').className='st er'}};
$('sync').onclick=async()=>{$('cs').textContent='Syncing…';$('cs').className='st';try{const r=await api('/sync',{method:'POST'});if(r.ok){$('cs').textContent='Synced '+r.count+' products.';$('cs').className='st ok';load()}else{$('cs').textContent='Sync failed: '+(r.error||'unknown');$('cs').className='st er'}}catch(e){$('cs').textContent='Sync failed: '+e.message;$('cs').className='st er'}};
load();
</script></body></html>`;

module.exports = router;
