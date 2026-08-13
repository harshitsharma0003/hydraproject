# Hydra — platform

The backend, database and merchant console for Hydra AI merchandising.
Everything runs on a single VM: PostgreSQL + pgvector, SFTP catalog drop,
gateway API, two background workers, and the console.

The storefront packages (SFCC cartridge, Shopify app) live separately — this
repo is the brain they talk to.

---

## Install on a fresh VM

Ubuntu 22.04 or 24.04, 4 vCPU / 8 GB RAM minimum.

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/harshitsharma0003/hydraproject.git /tmp/hydra
sudo bash /tmp/hydra/setup/install.sh \
  --domain hydra.yourdomain.com --email ops@yourdomain.com
```

The installer clones this repo to `/opt/hydra`, so redeploys are:

```bash
sudo hydra-update
```

Full detail: [`setup/README.md`](setup/README.md).

---

## Layout

```
db/migrations/    schema — 0001 core, 0002 bulk ingest
gateway/src/      API, intent parsing, retrieval, workers
console/          merchant-facing React SPA
setup/            VM installer and operations guide
```

## The request path

```
POST /v1/query
  auth (publishable key, origin-locked) -> rate limit -> quota
  cache lookup                             ~70% hit rate in steady state
  Claude intent parse (on miss)            taxonomy under prompt caching
  hybrid retrieval                         one SQL pass, RRF fusion
  widening ladder                          relax until the result floor clears
  -> { token, masterIds, intent, relaxed }
```

The gateway returns **product IDs, never products and never prices**. The
storefront hydrates them inside the shopper's own session, so price book,
customer group and active promotions all resolve correctly.

## Bulk ingest

```
storefront  -> /v1/bulk/begin        opens a job, returns an SFTP drop path
            -> chunk-00001.ndjson.gz gzipped NDJSON, 20k rows each
            -> manifest.json LAST    the trigger
hydra-ingest -> checksums, COPY into staging, promote
hydra-embed  -> claims batches, writes vectors, closes the job
```

Nothing ingests until the manifest lands, so an interrupted upload leaves the
live index untouched. Existing embeddings are replaced one batch at a time — a
resync never blanks the index mid-flight.

---

## Status

The core engine is built. **None of it has been executed against a live
database or API.** Read [`MANUAL-STEPS.md`](MANUAL-STEPS.md) Part B before
deploying — it ranks every unverified item.

Known gaps, in rough priority order:

- `intent.chips` is consumed by both storefronts but never produced
- `visitor_profiles` exists; nothing writes it (no personalisation yet)
- `gift_buckets` layout is emitted by the parser with no renderer
- `NARRATION_MODEL` is configured and never called
- No email, no purchase funnel, no internal admin
- No tests
