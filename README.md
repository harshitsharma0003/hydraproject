# Algivo Platform (internal)

The backend, database and merchant console. This package is **not** shipped to
customers.

```
db/          Postgres schema + Supabase setup
gateway/     The brain: intent parsing, retrieval, ranking, metering
console/     Merchant-facing UI (one console, both platforms)
```

---

## Quick start

```bash
cp .env.example .env          # fill in DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY
psql "$DATABASE_URL" -f db/migrations/0001_init.sql

cd gateway && npm install && npm start     # :8080
cd ../console && npm install && npm run dev # :5173
```

---

## Two model providers, not one

Claude handles intent parsing and narration. **Anthropic does not offer an
embeddings endpoint** — their documentation points to Voyage AI for Claude
pairings, so a second vendor is required for vectors.

This is not a problem, just a line item that nobody mentions until integration
week. `gateway/src/embeddings.js` keeps it behind an interface so swapping to a
self-hosted model later is a config change, and `embed_model` is stored on every
product row so you know exactly what needs re-embedding after an upgrade.

---

## Request path

```
POST /v1/query
  auth (publishable key, origin-locked)
  quota check ......................... soft-fail, never a hard cutoff
  cache lookup ........................ ~70% hit rate in steady state
  Claude intent parse (on miss) ....... taxonomy under prompt caching
  hybrid retrieval .................... one SQL pass, RRF fusion
  widening ladder ..................... relax until the floor clears
  issue token
  -> { token, masterIds, intent, relaxed }
```

The gateway returns **IDs, never products and never prices**. The storefront
algivotes them in the shopper's own session, so price book, customer group and
active promotions all resolve correctly.

---

## Endpoints

| Route | Key | Purpose |
|---|---|---|
| `POST /v1/query` | publishable | Resolve intent, return token + ranked IDs |
| `POST /v1/refine` | publishable | Chip click / follow-up with prior intent |
| `POST /v1/event` | either | Attribution beacon, erasure requests |
| `POST /v1/sync` | secret | Catalog ingest, content-hash delta embedding |
| `POST /v1/discover` | secret | Auto-discovery intake, builds taxonomy prompt |
| `POST /api/console/*` | JWT | Console: rules, queries, usage |

---

## Cost controls already in place

- Content-hash delta embedding — 1–3% of catalog re-embedded per night, not 100%
- Master-level embedding with variant rollup — roughly 4–20× fewer vectors
- `halfvec` float16 — halves index RAM, no measurable ranking loss
- Normalised query cache — the single highest-ROI component
- Narration tier-gated — it roughly doubles per-query model cost
- Per-tenant cost telemetry in `usage_meter` — know your real gross margin
  before renewal, not after

---

> **Read `MANUAL-STEPS.md` first.** Nothing in this package has been executed —
> no database provisioned, no API called. Part B of that document lists every
> unverified item in priority order, including one that will break every query
> on a site if a merchandiser enters a boost multiplier of zero.

## Before production

- [ ] Run the migration against a scratch database and confirm the generated
      `tsvector` column and `algivo_retrieve` compile
- [ ] Replace the placeholder rates in `meter.js` with your actual contract rates
- [ ] Move boosts in `algivo_retrieve` to a materialised lookup once rule volume
      is real — the correlated subquery is correct but not fast
- [ ] Connect as `algivo_app`, never as the table owner, or RLS is bypassed
- [ ] Load-test with the HNSW index warm and cold; the difference is 40×
