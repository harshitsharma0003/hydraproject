# Algivo platform — VM installation

Everything on one virtual machine: PostgreSQL + pgvector, the SFTP drop, the
gateway API, both background workers, the merchant console, and nginx.

---

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 | Ubuntu 24.04 |
| vCPU | 4 | 8 |
| RAM | 8 GB | 16 GB |
| Disk | 100 GB SSD | 250 GB SSD |

**RAM is the binding constraint, not disk.** HNSW indexes must stay resident;
once they spill, lookups go from ~5 ms to 200 ms+. Budget roughly 500 MB of
index per tenant at 50k masters, and provision RAM against the total across all
tenants.

Region matters — every query round-trips to this database. Put it near your
first design partner.

---

## Install

```bash
scp algivo-platform-1.0.0.zip user@vm:/tmp/
ssh user@vm
cd /tmp && unzip algivo-platform-1.0.0.zip && cd algivo-platform
sudo bash setup/install.sh --domain algivo.yourdomain.com --email ops@yourdomain.com
```

Omit `--domain` for an IP-only install; nginx serves plain HTTP and you add TLS
later.

Roughly 5–10 minutes. It is idempotent — safe to re-run.

### What it does

1. Base packages
2. PostgreSQL 16 + pgvector, **verified ≥ 0.7.0** (halfvec requires it) and
   tuned to the host's actual RAM
3. Node 20
4. `algivo` service user, `sftpusers` group, directory tree
5. OpenSSH configured for chrooted, key-only, shell-less SFTP
6. Application code, dependencies, console build
7. `.env` with generated secrets; migrations run as owner
8. Three systemd units + logrotate
9. nginx, optionally with certbot TLS
10. ufw, cron jobs, credentials written to `/root/algivo-credentials.txt`

---

## After install

```bash
sudo -u algivo nano /opt/algivo/gateway/.env      # ANTHROPIC_API_KEY, VOYAGE_API_KEY
sudo systemctl start algivo-gateway algivo-ingest algivo-embed
curl localhost:8080/health
```

### Verify tenant isolation before onboarding a second customer

```bash
sudo -u postgres psql -d algivo -c "
  SET ROLE algivo_app;
  SELECT set_config('algivo.tenant_id','<tenant-uuid>',false);
  SELECT count(*) FROM algivo.products;"
```

Must return only that tenant's rows. If not, stop — the security data sheet's
isolation claim depends on this, and the usual cause is the app connecting as
the table owner (owners bypass RLS).

---

## Per-merchant SFTP accounts

```bash
sudo algivo-sftp-user acme_prod /tmp/acme_id_ed25519.pub
```

Then enable it for the site:

```sql
UPDATE algivo.sites
   SET sftp_username = 'acme_prod', sftp_enabled = true
 WHERE external_site_id = 'AcmeProd';
```

Each account is chrooted to its own directory, key-only, with no shell and no
port forwarding. **A compromised merchant credential cannot reach another
tenant's catalog.**

Give the merchant: hostname, username, port 22, and the matching private key.

---

## Services

| Unit | Does |
|---|---|
| `algivo-gateway` | API on :8080 behind nginx |
| `algivo-ingest` | Watches SFTP drops, loads and promotes catalogs |
| `algivo-embed` | Drains the embedding queue |

```bash
sudo systemctl status algivo-gateway
sudo journalctl -u algivo-ingest -f
tail -f /var/log/algivo/embed.log
```

Run multiple embedding workers to go faster — `embed_claim()` uses
`SKIP LOCKED`, so they never collide and need no coordinator:

```bash
sudo systemctl start algivo-embed@2 algivo-embed@3   # after templating the unit
```

---

## How a bulk sync flows

```
SFCC job / Shopify bulk op
   -> POST /v1/bulk/begin            opens a job, returns a drop path
   -> writes chunk-00001.ndjson.gz   gzipped NDJSON, 20k rows each
   -> writes manifest.json LAST      the trigger
algivo-ingest
   -> verifies checksums and row counts
   -> streams each chunk into products_staging via COPY
   -> ingest_promote(): upsert, queue changed rows, mark absent rows offline
algivo-embed
   -> claims batches, embeds, writes vectors, marks the job complete
```

Nothing ingests until the manifest lands, so an interrupted upload leaves the
live index untouched. Failed jobs move to `failed/<jobId>/` and stay on disk for
inspection rather than being deleted.

---

## Directory layout

```
/opt/algivo/gateway          API + workers
/opt/algivo/console/dist     built SPA, served by nginx
/opt/algivo/db/migrations    schema
/srv/algivo/sftp/<user>/     incoming, processed, failed
/var/log/algivo/             gateway.log, ingest.log, embed.log
/root/algivo-credentials.txt generated secrets
```

---

## Backups

The catalog index is rebuildable from a full sync. These are not:
`visitor_events`, `merch_rules`, `usage_meter`, `licenses`, `api_keys`.

```bash
sudo -u postgres pg_dump -Fc algivo > /backup/algivo-$(date +%F).dump
```

---

## Scaling past one VM

This layout is right up to roughly 20–30 tenants. Beyond that, in order:

1. Move Postgres to managed hosting; keep the app tier here
2. Run embedding workers on separate machines — they are stateless
3. Give large tenants their own `products` partition
4. Split the gateway behind a load balancer

Only the ingest worker is pinned to the SFTP host, because it reads local disk.

---

## Secrets

**Never put a key in `setup/install.sh` or anywhere else in this repo.** The
repo is public; GitHub is scraped for committed credentials within minutes of a
push. Secrets live only in `/opt/algivo/gateway/.env`, which is `chmod 600`,
owned by `algivo`, and gitignored.

### At install

Environment variables are safer than flags — a flag is visible in shell history
and in `ps` output while the process runs:

```bash
sudo POSTMARK_TOKEN=xxxxxxxx \
     ANTHROPIC_API_KEY=sk-ant-xxxx \
     VOYAGE_API_KEY=pa-xxxx \
     bash setup/install.sh \
       --domain algivo.yourdomain.com \
       --email ops@yourdomain.com \
       --email-provider postmark \
       --email-from "Algivo <no-reply@mail.yourdomain.com>"
```

Flags exist too (`--postmark-token`, `--anthropic-key`, `--voyage-key`) but the
installer warns when you use them.

### After install

```bash
sudo algivo-set EMAIL_PROVIDER postmark
sudo algivo-set POSTMARK_TOKEN xxxxxxxx
```

Writes to `.env` and restarts the services. Nothing to edit by hand.

### Verify delivery before trusting it

```bash
sudo algivo-test-email you@example.com
```

Sends a real password-reset email through the configured provider. Do this
before your first customer, not after they fail to reset their password.

### If a key is ever exposed

Rotate first, investigate second. Pasting a token into a chat, a ticket, or a
commit all count as exposure — assume it is public from that moment.

| Key | Rotate at |
|---|---|
| Postmark | Servers → your server → API Tokens |
| Anthropic | console.anthropic.com → API keys |
| Voyage | dashboard → API keys |
| Algivo tenant keys | Console → Environments → Rotate |

### DNS before the first real send

`mail.yourdomain.com` needs SPF, DKIM and DMARC. Postmark gives you the exact
records. Without them, password-reset emails land in spam and customers
conclude the product is broken.
