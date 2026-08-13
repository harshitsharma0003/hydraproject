# Hydra platform — VM installation

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
scp hydra-platform-1.0.0.zip user@vm:/tmp/
ssh user@vm
cd /tmp && unzip hydra-platform-1.0.0.zip && cd hydra-platform
sudo bash setup/install.sh --domain hydra.yourdomain.com --email ops@yourdomain.com
```

Omit `--domain` for an IP-only install; nginx serves plain HTTP and you add TLS
later.

Roughly 5–10 minutes. It is idempotent — safe to re-run.

### What it does

1. Base packages
2. PostgreSQL 16 + pgvector, **verified ≥ 0.7.0** (halfvec requires it) and
   tuned to the host's actual RAM
3. Node 20
4. `hydra` service user, `sftpusers` group, directory tree
5. OpenSSH configured for chrooted, key-only, shell-less SFTP
6. Application code, dependencies, console build
7. `.env` with generated secrets; migrations run as owner
8. Three systemd units + logrotate
9. nginx, optionally with certbot TLS
10. ufw, cron jobs, credentials written to `/root/hydra-credentials.txt`

---

## After install

```bash
sudo -u hydra nano /opt/hydra/gateway/.env      # ANTHROPIC_API_KEY, VOYAGE_API_KEY
sudo systemctl start hydra-gateway hydra-ingest hydra-embed
curl localhost:8080/health
```

### Verify tenant isolation before onboarding a second customer

```bash
sudo -u postgres psql -d hydra -c "
  SET ROLE hydra_app;
  SELECT set_config('hydra.tenant_id','<tenant-uuid>',false);
  SELECT count(*) FROM hydra.products;"
```

Must return only that tenant's rows. If not, stop — the security data sheet's
isolation claim depends on this, and the usual cause is the app connecting as
the table owner (owners bypass RLS).

---

## Per-merchant SFTP accounts

```bash
sudo hydra-sftp-user acme_prod /tmp/acme_id_ed25519.pub
```

Then enable it for the site:

```sql
UPDATE hydra.sites
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
| `hydra-gateway` | API on :8080 behind nginx |
| `hydra-ingest` | Watches SFTP drops, loads and promotes catalogs |
| `hydra-embed` | Drains the embedding queue |

```bash
sudo systemctl status hydra-gateway
sudo journalctl -u hydra-ingest -f
tail -f /var/log/hydra/embed.log
```

Run multiple embedding workers to go faster — `embed_claim()` uses
`SKIP LOCKED`, so they never collide and need no coordinator:

```bash
sudo systemctl start hydra-embed@2 hydra-embed@3   # after templating the unit
```

---

## How a bulk sync flows

```
SFCC job / Shopify bulk op
   -> POST /v1/bulk/begin            opens a job, returns a drop path
   -> writes chunk-00001.ndjson.gz   gzipped NDJSON, 20k rows each
   -> writes manifest.json LAST      the trigger
hydra-ingest
   -> verifies checksums and row counts
   -> streams each chunk into products_staging via COPY
   -> ingest_promote(): upsert, queue changed rows, mark absent rows offline
hydra-embed
   -> claims batches, embeds, writes vectors, marks the job complete
```

Nothing ingests until the manifest lands, so an interrupted upload leaves the
live index untouched. Failed jobs move to `failed/<jobId>/` and stay on disk for
inspection rather than being deleted.

---

## Directory layout

```
/opt/hydra/gateway          API + workers
/opt/hydra/console/dist     built SPA, served by nginx
/opt/hydra/db/migrations    schema
/srv/hydra/sftp/<user>/     incoming, processed, failed
/var/log/hydra/             gateway.log, ingest.log, embed.log
/root/hydra-credentials.txt generated secrets
```

---

## Backups

The catalog index is rebuildable from a full sync. These are not:
`visitor_events`, `merch_rules`, `usage_meter`, `licenses`, `api_keys`.

```bash
sudo -u postgres pg_dump -Fc hydra > /backup/hydra-$(date +%F).dump
```

---

## Scaling past one VM

This layout is right up to roughly 20–30 tenants. Beyond that, in order:

1. Move Postgres to managed hosting; keep the app tier here
2. Run embedding workers on separate machines — they are stateless
3. Give large tenants their own `products` partition
4. Split the gateway behind a load balancer

Only the ingest worker is pinned to the SFTP host, because it reads local disk.
