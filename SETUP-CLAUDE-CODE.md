# Continuing this project in Claude Code

## 1. Get the repo onto your machine

If you have already pushed:

```bash
git clone https://github.com/harshitsharma0003/hydraproject.git algivo
cd algivo
```

If not, unzip `algivoproject-git-ready.zip` — the commit history and remote are
already configured — then:

```bash
cd hydraproject
git push -u origin main
```

## 2. Add the secrets file

`setup/secrets.env` is gitignored, so it is not in the clone. Copy it from
`algivo-platform-1.0.0.zip`, or recreate it:

```bash
cat > setup/secrets.env <<'ENV'
EMAIL_PROVIDER=postmark
POSTMARK_TOKEN=<your rotated token>
POSTMARK_STREAM=outbound
EMAIL_FROM=Algivo <no-reply@mail.algivo.thinkvisor.io>
EMAIL_REPLY_TO=support@thinkvisor.io
ANTHROPIC_API_KEY=
VOYAGE_API_KEY=
ENV
chmod 600 setup/secrets.env
```

## 3. Start Claude Code

```bash
claude
```

`CLAUDE.md` in the repo root loads automatically — architecture, invariants,
decisions, the SQL gotchas, and current state. You do not need to paste context.

## 4. Give it the storefront packages too

The cartridge and Shopify app live outside this repo. Either unzip them
alongside and open the parent directory, or add them as folders here:

```
algivo/
  gateway/  console/  db/  setup/   ← this repo
  ../algivo-sfcc/                   ← unzip beside it
  ../algivo-shopify/
```

Then start Claude Code from the parent so it can see all three.

## 5. First things to say

Openers that pick up exactly where this left off:

> Read CLAUDE.md. I'm installing on the VM today — walk me through it and watch
> for anything in the installer that will fail on a fresh Ubuntu 24.04 box.

> Read CLAUDE.md. I have an SFCC sandbox with a real apparel catalog. Help me
> upload the cartridge and work through caveat B1 in
> algivo-sfcc/documentation/06-manual-steps-and-caveats.md — the
> productSearch.productIds shape is the highest-risk unknown.

> Read CLAUDE.md, then build the order-history import: an optional feed on the
> SFCC and Shopify sides that seeds visitor_profiles so a known customer gets
> useful personalisation before their first click.

## 6. Working with git from Claude Code

It can commit and push directly. Worth saying once:

> Follow the commit convention in CLAUDE.md — one-line summary, blank line, then
> the reasoning. Run the verification commands before committing. Never commit
> setup/secrets.env.

## 7. Testing SQL changes locally

There is no Postgres requirement to run the app, but schema changes must be
executed before committing:

```bash
docker run -d --name algivo-pg -e POSTGRES_PASSWORD=postgres \
  -p 5433:5432 pgvector/pgvector:pg16
psql "postgresql://postgres:postgres@localhost:5433/postgres" \
  -c "CREATE DATABASE algivo" -c "\c algivo" \
  -c "CREATE EXTENSION vector; CREATE EXTENSION pg_trgm; CREATE EXTENSION pgcrypto;"
DATABASE_URL="postgresql://postgres:postgres@localhost:5433/algivo" \
  node gateway/scripts/migrate.js
```

Eight migrations should apply clean. The CI workflow does the same on every
push, so a broken migration fails there rather than on the VM.
