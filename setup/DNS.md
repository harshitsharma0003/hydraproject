# DNS for thinkvisor.io

Everything below points at one VM except the mail records, which point at
Postmark.

## Records

| Type | Name | Value | Purpose |
|---|---|---|---|
| A | `app` | `<VM IP>` | Console and public site |
| A | `api` | `<VM IP>` | Gateway — what storefronts call |
| A | `sftp` | `<VM IP>` | Catalog upload (port 22) |
| A | `shopify` | `<VM IP>` | Shopify app, if self-hosted |
| A | `@` | `<VM IP>` | Optional: marketing site at the apex |

`api` and `app` are separate hostnames deliberately. A bad console deploy or a
console outage then cannot touch the endpoint merchants' live storefronts depend
on, and the two can be rate-limited and monitored independently.

`sftp` is a convenience alias — SFTP rides port 22 on the same box.

## Email — `mail.algivo.thinkvisor.io`

Sending from a subdomain keeps your corporate mail reputation isolated. If a
send goes wrong, `@thinkvisor.io` is unaffected.

Postmark generates the exact values; the shape is:

| Type | Name | Value |
|---|---|---|
| TXT | `mail` | `v=spf1 a mx include:spf.mtasv.net ~all` |
| TXT | `<selector>._domainkey.mail` | Postmark's DKIM key |
| CNAME | `pm-bounces.mail` | `pm.mtasv.net` |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:dmarc@thinkvisor.io` |

Start DMARC at `p=none`. After two weeks of clean aggregate reports, move to
`p=quarantine`.

**Do this before the first real send.** Without SPF and DKIM, password-reset
emails land in spam and the customer concludes the product is broken.

## Install

```bash
sudo bash setup/install.sh \
  --domain algivo.thinkvisor.io \
  --api-domain api.algivo.thinkvisor.io \
  --email ops@thinkvisor.io
```

Certbot issues one certificate covering both hostnames. `setup/secrets.env` is
read automatically, so no flags are needed for the Postmark token.

## Verify

```bash
curl https://api.algivo.thinkvisor.io/health
sudo algivo-test-email you@thinkvisor.io
```

The second sends a real password-reset email through Postmark. Run it before
your first customer, not after they fail to reset a password.

## What merchants configure

**SFCC** — `algivo.gateway.cred` URL is `https://api.algivo.thinkvisor.io`,
`algivo.sftp.cred` host is `sftp.algivo.thinkvisor.io`. Both are pre-filled in the
shipped `services.xml`; only the SFTP username changes per merchant.

**Shopify** — nothing. OAuth provisions keys automatically.
