# Algivo — project brief

Natural-language merchandising for Salesforce B2C Commerce (SFRA) and Shopify.
A shopper types "outfit for my office" and gets a curated PLP rendered through
the merchant's **own** product templates — their tiles, their prices, their
stock.

Brand: Algivo. Live at `algivo.thinkvisor.io`. Company domain `thinkvisor.io`.

---

## The one idea everything else follows from

**The gateway returns product IDs. Never products, never prices.**

Correct price on SFCC is a function of price book × customer group × active
promotion campaigns × locale tax display. Two shoppers hitting the same URL at
the same second legitimately see different prices. Our server has no session, so
any price it renders is one we will eventually be wrong about.

So: Algivo decides **what is relevant**. The storefront decides **what is true**
— and renders it with its own tile template, which is also why results need zero
per-merchant CSS work.

```
shopper query
  → Claude parses intent, constrained to the merchant's real attribute taxonomy
  → hybrid retrieval (lexical + vector, RRF fusion) over our catalog index
  → widening ladder until a result floor is met
  → token + ordered master IDs
  → cartridge hydrates: drops offline / unpriced / out-of-stock, applies
    live price and promotions, renders through the merchant's searchResults.isml
```

---

## Packages

| Path | Ships to | Contains |
|---|---|---|
| this repo | internal only | gateway, DB, workers, console, VM installer |
| `algivo-sfcc` | SFCC customers | two cartridges, metadata, 6 docs |
| `algivo-shopify` | Shopify customers | Remix app, theme extension |

This repo is **public**, so secrets live only in `setup/secrets.env`
(gitignored) and `/opt/algivo/gateway/.env` on the VM. A committed Postmark
token gets flagged by GitHub scanning and auto-revoked by Postmark, so
committing it breaks the install rather than simplifying it.

---

## Invariants — do not break these

1. **Never return a price or inventory count from the gateway.** Both belong to
   the storefront, resolved in the shopper's session.
2. **A gateway outage must never be a storefront outage.** Every client treats a
   non-ok response as "fall back to native search". Four degradation modes are
   documented in the SFCC runbook.
3. **Personalised results never enter the shared query cache.** One shopper's
   ranking leaking to every visitor on the site would be a serious bug. A
   personalised request reuses the cached *intent* and re-runs retrieval.
4. **Never personalise a gift query.** The parser sets `queryType`; someone
   shopping for their nephew does not want their own history in the results.
5. **Never bill a degraded query.** If we fell back to native search, it does
   not appear on the invoice. `usage_meter.degraded_queries` tracks them.
6. **Only production environments meter and bill.** Sandbox and UAT have their
   own caps so a merchant's QA suite cannot reach the invoice.
7. **Tenant isolation is enforced by Postgres RLS, not by query discipline.**
   The app connects as `algivo_app`, never as the table owner — owners bypass
   RLS and the security data sheet's claim depends on this.
8. **Never guess a schema.** Two files (`urlrules-algivo.xml`,
   `page-instance-reference.xml`) are shipped as *references only*, outside the
   auto-import, because their exact element names were not verified and both
   imports are replace-not-merge.

---

## Stack

- **Gateway** Node 20 + Express, `gateway/src`
- **DB** PostgreSQL 16 + pgvector 0.8 (`halfvec`, HNSW), schema `algivo`
- **Models** Claude Haiku 4.5 for intent (tool use + prompt caching), Sonnet for
  narration. **Anthropic has no embeddings endpoint** — Voyage is used, behind
  an interface in `gateway/src/embeddings.js`.
- **Console** React + Vite, `console/`
- **Workers** `ingest` (SFTP), `embed`, `profiles`
- **Email** pluggable: SMTP / Resend / Postmark / SendGrid / console

---

## Decisions worth knowing before you change something

**Master-level embeddings, not variants.** A shirt in 5 colours × 6 sizes is 30
SKUs but one style. Embedding variants would fill top-K with near-identical
duplicates and cost 4–20× more. Colours and sizes roll up into arrays.

**`halfvec` (float16), not `vector`.** Halves index RAM with no measurable
ranking loss. RAM is the binding constraint — once HNSW spills to disk, lookups
go from ~5 ms to 200 ms+.

**Content-hash delta embedding.** Only rows whose embeddable text changed get
re-embedded — 1–3% of catalog per day. Price and stock changes never touch the
vector.

**Embedding happens in a worker, not in the sync request.** It used to be
inline, which made each batch take 5–10 s and turned a 200k-master catalog into
~53 minutes of held-open HTTP with no resumability.

**`ingest_promote` never clears the old embedding.** Products stay searchable
during a resync; vectors are swapped one batch at a time.

**A full sync marks missing products offline, not deleted.** An accidental
partial export is then reversible.

**Manifest is written last.** The SFTP ingest worker ignores a drop directory
until `manifest.json` appears, so an interrupted upload can never promote a
partial catalog.

**Chips: the model picks the dimension, the gateway picks the values.** Values
are counted from the products actually retrieved, so a chip can never land on an
empty grid. A model-invented "Petite" on a catalog with no petite products is
worse than no chip.

**`server.prepend`, not `append`, on `Search-Show`.** Append runs after the base
controller has already done a full search we then discard. Prepend short-circuits
with three guards, cheapest first, and a try/catch that falls through — an
Algivo bug can never do worse than a normal search result.

**Bifurcation is by URL token, not session state.** `?algivoToken=…` present
means Algivo; absent means the merchant's normal flow, always. Session-keyed
would break the back button, bookmarks and page cache.

**JWTs carry only a user id.** Role and status are read per request. An earlier
version put the role in the token, so demoting someone left their permissions
live for up to 12 hours.

**Sandbox caches never expire.** Testing repeats the same 50–200 queries;
production sees a long tail. A sandbox costs ~$0.44 once, then nothing.

---

## Gotchas found by actually running it

These cost real debugging time. Do not reintroduce them.

- `to_tsvector('english', x)` resolves to the **one-argument STABLE** form and is
  rejected in a generated column. Needs `'english'::regconfig`.
- `array_to_string` is **STABLE**, so nothing touching it can appear in a
  generated column at all.
- `now()` cannot appear in an index predicate.
- A unique constraint on a partitioned table **must include the partition key**.
- Changing a column to an enum leaves the old `CHECK (x IN (…))` behind, where
  it becomes `enum = text` with no operator. Drop it first.
- **pgvector has no scalar multiply.** `*` is elementwise. Scale by multiplying
  against `array_fill(w, ARRAY[1024])::vector`.
- `avg(halfvec)` exists natively — no cast needed.

---

## State

**Working and verified against live Postgres 16.14 + pgvector 0.8.0:**
8 migrations, 36+ tables, RRF retrieval, ban/pin/boost, widening ladder, RLS
isolation (other tenant sees 0 rows where owner sees 3), HNSW index used by the
planner, last-owner trigger, `multiplier > 0`, partition routing, visitor
profiles built from clicks.

**Built, not yet run against a real instance:** SFTP ingest, embedding worker
against a live Voyage key, both storefront packages, Postmark delivery.

**Not built:**
- `gift_buckets` layout — parser emits it, no renderer
- monthly invoice generation job (Stripe webhook writes invoices; nothing rolls
  `billing_summary` into a row)
- tests, monitoring, status page
- ToS / privacy policy / DPA
- `platform_staff` + `impersonation_sessions` have tables, no routes
- order-history import to seed profiles before a shopper's first click

---

## Commands

```bash
# migrations (idempotent)
DATABASE_URL=... node gateway/scripts/migrate.js

# gateway + workers
cd gateway && npm install && npm start
node src/worker/ingest.js
node src/worker/embed.js
node src/worker/profiles.js

# console
cd console && npm install && npm run dev

# deploy
sudo bash setup/install.sh --domain algivo.thinkvisor.io \
     --api-domain api.algivo.thinkvisor.io --email ops@thinkvisor.io
sudo algivo-update          # after every push
sudo algivo-set KEY VALUE   # change a secret, restarts services
sudo algivo-test-email you@thinkvisor.io
```

**Verify before committing** — CI runs these, but they are fast locally:

```bash
for f in $(find . -name "*.js" -not -path "*/node_modules/*"); do node --check "$f"; done
for f in $(find . -name "*.json" -not -path "*/node_modules/*"); do node -e "JSON.parse(require('fs').readFileSync('$f'))"; done
python3 -c "import xml.dom.minidom,glob; [xml.dom.minidom.parse(f) for f in glob.glob('**/*.xml',recursive=True)]"
bash -n setup/install.sh
```

For SQL changes, run the migrations against a scratch database before
committing. The CI `migrate` job does this with `pgvector/pgvector:pg16`.

---

## Conventions

- Comments explain **why**, especially where a choice looks odd. If something is
  non-obvious or was learned the hard way, say so at the point of the code.
- Commit messages: one-line summary, blank line, then the reasoning — what
  changed and what it prevents.
- Never commit `setup/secrets.env` or any `.env`.
- Documentation lives with the package it describes. Customer-facing caveats go
  in `MANUAL-STEPS.md` Part B, ranked by risk, with an honest note when
  something has not been verified.

---

## Next, in priority order

1. Install on the VM, add `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`, smoke test.
2. Upload the cartridge to the SFCC sandbox, run `AlgivoDiscover`, read the
   detection report.
3. Verify SFCC caveats B1 (`productSearch.productIds` shape — wrong means an
   empty grid with no error) and B9b (SFTP export path).
4. Order-history import to seed profiles.
5. Invoice generation job.
6. Tests and monitoring.
