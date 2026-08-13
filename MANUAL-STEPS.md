# Hydra Platform — Setup Steps & Known Caveats

Internal. Not shipped to customers.

---

# PART A — Setup steps

## A0. Install the VM

```bash
sudo bash setup/install.sh --domain hydra.example.com --email ops@example.com
```

See `setup/README.md`. Sections A1–A3 below are performed by that script; they
are documented here for the case where you run the database separately.

## A1. Database

See `db/SUPABASE-SETUP.md` for the full walkthrough. The two things that will
silently break you:

- **Use the session pooler (port 5432), not the transaction pooler (6543).**
  `SET LOCAL hydra.tenant_id` needs session state the transaction pooler does
  not preserve. Getting this wrong causes intermittent cross-tenant reads under
  load — the worst possible failure mode.
- **Connect as `hydra_app`, never as the table owner or `postgres`.** Owners
  bypass RLS, which invalidates the isolation claim in the customer security
  data sheet.

```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
cd gateway && npm run migrate
```

Confirm pgvector ≥ 0.7.0 — `halfvec` does not exist before that:

```sql
SELECT extversion FROM pg_extension WHERE extname = 'vector';
```

## A2. Verify tenant isolation before onboarding a second customer

```sql
SET ROLE hydra_app;
SELECT set_config('hydra.tenant_id', '<tenant-a-uuid>', false);
SELECT count(*) FROM hydra.products;   -- must show ONLY tenant A
```

If this returns rows from other tenants, stop. Do not onboard anyone.

## A3. Scheduled jobs

```sql
SELECT cron.schedule('hydra-purge',      '0 3 * * *', $$SELECT hydra.hydra_purge(90)$$);
SELECT cron.schedule('hydra-partitions', '0 4 1 * *', $$SELECT hydra.hydra_ensure_partitions(3)$$);
```

The partition job matters: without it, events fall into
`visitor_events_default`, which still works but loses the drop-partition fast
path for retention.

## A4. Environment

Fill `.env` from `.env.example`. `BOOTSTRAP_SECRET` must match the Shopify app's
`HYDRA_BOOTSTRAP_SECRET` or OAuth installs cannot provision.

## A5. First console user

```sql
INSERT INTO hydra.console_users (tenant_id, email, password_hash, role)
VALUES ('<tenant-uuid>', 'ops@merchant.com', crypt('changeme', gen_salt('bf')), 'owner');
```

## A6. Stripe

Point the webhook at `POST /v1/billing/webhook`, subscribing to
`checkout.session.completed`, `customer.subscription.deleted`,
`invoice.payment_failed`. Set `metadata.platform` and `metadata.tier` on the
Checkout Session, or provisioning defaults to `sfcc_sfra` / `starter`.

---

## A7. Per-merchant SFTP account

```bash
sudo hydra-sftp-user <username> /path/to/their_key.pub
```

```sql
UPDATE hydra.sites SET sftp_username='<username>', sftp_enabled=true
 WHERE external_site_id='<site>';
```

Bulk sync returns `sftp_not_provisioned` until both are done.

---

# PART B — What could not be verified

**Nothing in this package has been executed.** No database was provisioned, no
API was called, no query was run. Treat all of Part B as untested.

## B1. CRITICAL — The SQL has never run

`db/migrations/0001_init.sql` is syntax-reviewed but **never executed against
Postgres**. Run it on a scratch database first.

Highest-risk constructs:

- The generated `search_doc` `tsvector` column — generated columns require a
  provably immutable expression; the `setweight`/`to_tsvector` chain should
  qualify with a literal regconfig, but this was not confirmed.
- `hydra_retrieve()` — 10 parameters, four CTEs, a `FULL OUTER JOIN`, and
  correlated subqueries. Any one could fail to compile.
- HNSW index creation on a **partitioned parent** table.
- `halfvec` casts in the function signature and in `toPgVector` output.

## B2. HIGH — `hydra_retrieve` boost subquery

The boost multiplier uses `exp(sum(ln(r.multiplier)))` to multiply across
matching rules. `ln()` of a value ≤ 0 raises an error, so a merchandiser
entering a multiplier of `0` (a plausible way to try to hide a product) would
break every query on that site.

**Fix before production:** add a `CHECK (multiplier > 0)` on `merch_rules`, or
clamp in the console. Not yet done.

The subquery is also correlated per row — correct but slow. Materialise it once
rule volumes are real.

## B3. HIGH — Voyage API response shape

`embeddings.js` assumes `{ data: [{ embedding: [...] }] }` and passes
`input_type` and `output_dimension`. **Not verified against the live API.**
Parameter names, the 128-item batch size, and whether `output_dimension` is
supported for your chosen model all need checking.

Also confirm the model name in `.env.example` is current — model names change.

## B4. HIGH — Claude model IDs and prompt caching

`intent.js` uses `claude-haiku-4-5-20251001` and two `cache_control: ephemeral`
breakpoints. **Verify both against current API docs** — model IDs are dated
strings and the cache-breakpoint limit is version-sensitive.

Also confirm the taxonomy block is actually large enough to exceed the minimum
cacheable token count. Below it, caching is a no-op and your cost model is
wrong.

## B5. HIGH — Placeholder pricing in `meter.js`

`PRICE_MICROS` contains **invented numbers**. Every cost figure the console
shows is currently fiction. Replace with your real contract rates before anyone
sees a usage screen.

## B6. MEDIUM — RLS on `console_users`

`console_users` is tenant-scoped but was added after the RLS loop and has **no
RLS policy**. Access is guarded only by the JWT check in `admin.js`.

A bug in `requireConsole` would therefore expose all tenants' users. Add it to
the RLS list before production.

## B7. MEDIUM — `crypt()` availability

`admin.js` authenticates with `crypt($2, u.password_hash)`, which needs
`pgcrypto` in the search path. The migration creates the extension, but if it
lands in `public` while queries run in `hydra`, login fails with "function
crypt does not exist".

## B8. MEDIUM — Bulk ingest path is entirely untested

Embedding now happens in a background worker, and full syncs arrive as gzipped
NDJSON chunks over SFTP, streamed into staging via `COPY`. **None of it has
run.** Specific risks:

- The CSV encoder in `worker/ingest.js` hand-builds Postgres array and JSONB
  literals. Quoting is the fragile part — a product title containing `"` or a
  backslash is the obvious first test case.
- `SFTPClient.putBinary()` behaviour on large gzipped files from an SFCC job
  step was not verified, nor was the SFCC job quota for a long-running export.
- The chroot ACL setup grants the `hydra` user access via `setfacl`. If the
  filesystem is mounted without ACL support, the ingest worker cannot read
  merchant uploads.

**Test with a 100-product catalog before a real one.**

## B8b. MEDIUM — Shopify bulk operation shape

`bulk.server.js` assumes the JSONL emits parent product lines without
`__parentId` and that nested `variants.edges` arrive on the parent node.
**Bulk query result shapes vary** — Shopify sometimes flattens connections into
separate lines. If variant prices come back null, that is the cause.

## B9. MEDIUM — Widening ladder tuning

The five rungs and `RESULT_FLOOR = 8` in `retrieval.js` are **reasoned, not
measured**. The 15% price-band widening and the 1.2× relaxation are guesses.

Tune against the first design partner's real catalog. Expect this to be the main
thing you adjust in the first month.

## B10. MEDIUM — RRF constant

`p_rrf_k = 60` is the conventional default. Not tuned for apparel, and the
lexical/semantic balance it implies has not been evaluated.

## B11. LOW — Console is a functional skeleton

Login, sites, rules, queries and usage all work in shape, but there is no
pagination, no optimistic updates, no error toasts, no role enforcement in the
UI (roles exist in the schema but `admin.js` does not check them), and no
password reset. Adequate for a pilot; not for self-serve.

## B12. LOW — No rate limiting

The gateway has quota metering but **no per-key rate limiting**. A misbehaving
storefront loop could exhaust a month's quota in minutes. Add before any
customer runs unattended.

## B13. LOW — Health route `Promise.all`

`routes/health.js` runs three queries via `Promise.all` with no individual error
handling. One failing query fails the whole health check — which is exactly when
you most need it to respond.

---

## Suggested order before first customer

1. Run the migration on a scratch database (B1)
2. Fix the `multiplier > 0` check (B2)
3. Verify Voyage and Claude calls with a 10-product catalog (B3, B4)
4. Add RLS to `console_users` (B6)
5. Replace pricing placeholders (B5)
6. Add per-key rate limiting (B12)
7. Load-test sync with a realistic catalog (B8)
8. Tune the widening ladder against real data (B9)

---

# PART C — Roles and access

## Role matrix

| | Owner | Admin | Developer | Merchandiser | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| View sites, rules, queries, syncs | ● | ● | ● | ● | ● |
| Edit merchandising rules | ● | ● | | ● | |
| Flush cache | ● | ● | ● | ● | |
| Rotate API keys | ● | ● | ● | | |
| Trigger syncs | ● | ● | ● | | |
| Manage users | ● | ● | | | |
| Grant the owner role | ● | | | | |
| Change plan, buy credits | ● | | | | |
| Read audit log | ● | ● | | | |
| Delete the account | ● | | | | |

**Developer, merchandiser and viewer can be scoped to specific sites.** No
assignment means tenant-wide. Owners and admins always see everything.

## Guarantees enforced in the database, not the application

- **The last owner cannot be removed, demoted or suspended.** A trigger raises,
  so it holds even for a route added later that forgets to check.
- **Only an owner can create another owner.** Otherwise an admin could escalate
  by inviting an owner account they control.
- **Nobody can change or suspend their own role**, which prevents locking
  yourself out and prevents self-escalation in one rule.
- **The audit log is append-only.** `hydra_app` has no `UPDATE` or `DELETE`
  grant on it, so a compromised gateway cannot rewrite history.

## Revocation is immediate

Tokens carry only a user id. Role, status and tenant are read from the database
on every request, and any role change, suspension or password change bumps
`token_valid_from`, which invalidates every token issued before it.

The earlier design put the role inside the JWT, which meant a demoted user kept
their old permissions for up to 12 hours. That is fixed.

## Login protection

Five failed attempts locks an account for fifteen minutes. Every failure mode —
unknown email, wrong password, locked, suspended — returns the same response, so
the login form cannot be used to discover which addresses are registered.

## Invitations

Invite tokens are stored hashed, expire in 7 days and work once. Treat an invite
link like a password.

**Email delivery is not built yet.** The invite endpoint returns the link and
the UI displays it, so the flow works today by sending it manually. This is
deliberate rather than silently failing, but it is the first thing to wire up
when the mailer exists.

## Platform staff

`platform_staff` and `impersonation_sessions` exist for your own team:
cross-tenant, read-only by default, with time-boxed and audited impersonation.
**The routes for these are not built.** The tables are there so support access
is designed in rather than retrofitted, but for now your team uses psql.
