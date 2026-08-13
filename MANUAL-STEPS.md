# Algivo Platform — Setup Steps & Known Caveats

Internal. Not shipped to customers.

---

# PART A — Setup steps

## A0. Install the VM

```bash
sudo bash setup/install.sh --domain thinkvisor.io --email ops@example.com
```

See `setup/README.md`. Sections A1–A3 below are performed by that script; they
are documented here for the case where you run the database separately.

## A1. Database

See `db/SUPABASE-SETUP.md` for the full walkthrough. The two things that will
silently break you:

- **Use the session pooler (port 5432), not the transaction pooler (6543).**
  `SET LOCAL algivo.tenant_id` needs session state the transaction pooler does
  not preserve. Getting this wrong causes intermittent cross-tenant reads under
  load — the worst possible failure mode.
- **Connect as `algivo_app`, never as the table owner or `postgres`.** Owners
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
SET ROLE algivo_app;
SELECT set_config('algivo.tenant_id', '<tenant-a-uuid>', false);
SELECT count(*) FROM algivo.products;   -- must show ONLY tenant A
```

If this returns rows from other tenants, stop. Do not onboard anyone.

## A3. Scheduled jobs

```sql
SELECT cron.schedule('algivo-purge',      '0 3 * * *', $$SELECT algivo.algivo_purge(90)$$);
SELECT cron.schedule('algivo-partitions', '0 4 1 * *', $$SELECT algivo.algivo_ensure_partitions(3)$$);
```

The partition job matters: without it, events fall into
`visitor_events_default`, which still works but loses the drop-partition fast
path for retention.

## A4. Environment

Fill `.env` from `.env.example`. `BOOTSTRAP_SECRET` must match the Shopify app's
`ALGIVO_BOOTSTRAP_SECRET` or OAuth installs cannot provision.

## A5. First console user

```sql
INSERT INTO algivo.console_users (tenant_id, email, password_hash, role)
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
sudo algivo-sftp-user <username> /path/to/their_key.pub
```

```sql
UPDATE algivo.sites SET sftp_username='<username>', sftp_enabled=true
 WHERE external_site_id='<site>';
```

Bulk sync returns `sftp_not_provisioned` until both are done.

---

# PART B — What could not be verified

**Nothing in this package has been executed.** No database was provisioned, no
API was called, no query was run. Treat all of Part B as untested.

## B1. RESOLVED — the SQL now runs

All seven migrations were executed against PostgreSQL 16.14 with pgvector 0.8.0.
Result: **36 tables, 4 views, 17 functions, 99 indexes**, applied cleanly and
idempotently through `gateway/scripts/migrate.js`.

Five defects were found and fixed by running it. Each would have stopped the
install dead:

1. **`generation expression is not immutable`** — `to_tsvector('english', …)`
   resolves to the one-argument form, which is STABLE because it reads
   `default_text_search_config`. Fixed with an explicit `::regconfig` cast.
2. **Same error, second cause** — `array_to_string` is STABLE, so including
   `category_path` in the generated column was rejected regardless of the cast.
   Removed; categories are matched by array overlap in `algivo_retrieve` and
   the column held IDs rather than display names.
3. **`functions in index predicate must be marked IMMUTABLE`** — the partial
   index on `merch_rules` used `now()`. Expiry is filtered at query time now.
4. **`unique constraint on partitioned table must include all partitioning
   columns`** — `visitor_events` had `id` alone as the primary key. Now
   `(id, occurred_at)`.
5. **`operator does not exist: console_role = text`** — the original
   `CHECK (role IN (…))` survived the enum conversion. Dropped first.

Verified working against real data: hybrid retrieval with RRF fusion returning
ranked results, ban rules excluding products, the `multiplier > 0` constraint
rejecting zero, the last-owner trigger blocking deletion, `visitor_events`
partition routing, all helper functions, and **RLS isolation** — a session set
to a different tenant sees 0 rows where the owning tenant sees 3. The HNSW
index is used by the planner (`Index Scan using products_default_embedding_idx`).

What still has not been tested: the SFTP ingest path, the embedding worker
against a live Voyage key, and anything in the storefront packages.

## B2. HIGH — `algivo_retrieve` boost subquery

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
lands in `public` while queries run in `algivo`, login fails with "function
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
- The chroot ACL setup grants the `algivo` user access via `setfacl`. If the
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
- **The audit log is append-only.** `algivo_app` has no `UPDATE` or `DELETE`
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

---

# PART D — Email and request tracing

## D1. Choose a mail provider

Set `EMAIL_PROVIDER` in `.env` to one of `smtp`, `resend`, `postmark`,
`sendgrid` or `console`.

`smtp` works with any host — Zoho, Google Workspace, Amazon SES SMTP, Mailgun.
The HTTP providers need only an API key.

**`console` is the default after install and never delivers anything.** It
prints to the log so you can develop without a provider. Password reset and
invites will silently do nothing until you change it, which is the first thing
to check if a customer says they never got their invite.

## D2. Sending domain

Whichever provider you pick, add SPF, DKIM and DMARC records for your sending
domain before the first real send. Without them, password-reset emails land in
spam and your customers conclude the product is broken.

## D3. Bounce webhook

Point your provider's bounce and complaint webhook at
`POST /api/email/webhook`. Bounced and complained addresses go into
`email_suppressions` and are never sent to again — repeat sends to dead
addresses are how a sending domain's reputation dies.

## D4. What gets sent

| Template | Trigger |
|---|---|
| `welcome` | Signup — includes the publishable key only |
| `password_reset` | Reset requested; 30-minute single-use link |
| `password_changed` | Password changed — security notice, always sent |
| `user_invited` | Someone is invited to the account |
| `quota_warning` | 80% and 100% of monthly quota, once each per period |
| `sync_failed` | Catalog ingest fails |

Every send is recorded in `email_log` with its request id, so "did they get the
invite?" is a query rather than a trip into the provider dashboard.

## D5. Request ids

Every response carries `X-Request-Id`. Errors include it in the body, and the
console shows it beneath failure messages.

Inbound ids are honoured, so a cartridge call and the gateway work it triggers
share one trace. Logs are JSON lines including `requestId`, so:

```bash
grep '"requestId":"<id>"' /var/log/algivo/gateway.log | jq
```

Ask customers for the reference shown in the UI. It maps to exactly one request.

## D6. Password reset behaviour

- Links expire in 30 minutes and work once
- Three requests per hour per account, silently enforced
- `/auth/forgot` always returns the same response, so it cannot be used to
  discover which addresses are registered
- Resetting signs out every other session and invalidates any other outstanding
  reset link
- A "your password was changed" notice is always sent — that is how a user finds
  out if the reset was not them
