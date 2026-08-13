#!/usr/bin/env bash
#
# Hydra platform — single-VM installer
#
# Installs and wires: PostgreSQL 16 + pgvector, a chrooted SFTP server, the
# gateway API, both background workers, the merchant console, and nginx with TLS.
#
# Target:  Ubuntu 22.04 or 24.04, x86_64
# Sizing:  4 vCPU / 8 GB RAM / 100 GB SSD minimum.
#          RAM is the real constraint — HNSW indexes must stay resident. Budget
#          ~500 MB of index per tenant at 50k masters. Once the index spills to
#          disk, lookups go from ~5 ms to 200 ms+.
#
# Usage:   sudo bash install.sh
#          sudo bash install.sh --domain hydra.example.com --email ops@example.com
#
set -euo pipefail

DOMAIN=""
EMAIL=""
REPO="${HYDRA_REPO:-https://github.com/harshitsharma0003/hydraproject.git}"
BRANCH="${HYDRA_BRANCH:-main}"
DB_NAME="hydra"
DB_APP_USER="hydra_app"
SFTP_ROOT="/srv/hydra/sftp"
APP_ROOT="/opt/hydra"
NODE_MAJOR=20
PG_MAJOR=16

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email)  EMAIL="$2";  shift 2 ;;
    --repo)   REPO="$2";   shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) echo "unknown option: $1"; exit 1 ;;
  esac
done

log()  { echo -e "\n\033[1;34m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die()  { echo -e "\033[1;31m[fail]\033[0m $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash install.sh)"

# ---------------------------------------------------------------------------
log "1/10  Base packages"
# ---------------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg lsb-release git build-essential \
  nginx ufw openssh-server acl jq unzip pwgen

# ---------------------------------------------------------------------------
log "2/10  PostgreSQL ${PG_MAJOR} + pgvector"
# ---------------------------------------------------------------------------
install -d /usr/share/postgresql-common/pgdg
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq "postgresql-${PG_MAJOR}" "postgresql-client-${PG_MAJOR}" \
                       "postgresql-${PG_MAJOR}-pgvector"

systemctl enable --now postgresql

# pgvector 0.7+ is required for halfvec. Fail loudly rather than at migration.
PGV=$(sudo -u postgres psql -tAc \
  "SELECT default_version FROM pg_available_extensions WHERE name='vector'")
[[ -n "$PGV" ]] || die "pgvector not available from the PGDG repo"
if [[ "$(printf '%s\n0.7.0\n' "$PGV" | sort -V | head -1)" != "0.7.0" ]]; then
  die "pgvector $PGV found, but halfvec needs >= 0.7.0"
fi
log "    pgvector $PGV OK"

# --- tuning: the defaults are wrong for a vector workload -------------------
TOTAL_MB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 ))
SHARED_MB=$(( TOTAL_MB / 4 ))
CACHE_MB=$(( TOTAL_MB * 3 / 4 ))
PGCONF="/etc/postgresql/${PG_MAJOR}/main/conf.d/hydra.conf"
install -d "$(dirname "$PGCONF")"
cat > "$PGCONF" <<EOF
# Tuned by Hydra install.sh for a ${TOTAL_MB}MB host.
shared_buffers = ${SHARED_MB}MB
effective_cache_size = ${CACHE_MB}MB
maintenance_work_mem = 1GB          # HNSW index builds are memory hungry
work_mem = 32MB
max_parallel_maintenance_workers = 4
random_page_cost = 1.1              # SSD
effective_io_concurrency = 200
max_connections = 100
EOF
systemctl restart postgresql

DB_APP_PASS=$(pwgen -s 32 1)
sudo -u postgres psql -qc "CREATE DATABASE ${DB_NAME}" 2>/dev/null || true
sudo -u postgres psql -d "$DB_NAME" -qc "CREATE EXTENSION IF NOT EXISTS vector"
sudo -u postgres psql -d "$DB_NAME" -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm"
sudo -u postgres psql -d "$DB_NAME" -qc "CREATE EXTENSION IF NOT EXISTS pgcrypto"

# The app connects as a NON-OWNER. Owners bypass RLS unless forced, and the
# tenant-isolation claim in the customer security sheet depends on this.
sudo -u postgres psql -d "$DB_NAME" -q <<EOF
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${DB_APP_USER}') THEN
    CREATE ROLE ${DB_APP_USER} LOGIN PASSWORD '${DB_APP_PASS}';
  ELSE
    ALTER ROLE ${DB_APP_USER} PASSWORD '${DB_APP_PASS}';
  END IF;
END \$\$;
EOF

# ---------------------------------------------------------------------------
log "3/10  Node ${NODE_MAJOR}"
# ---------------------------------------------------------------------------
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
apt-get install -y -qq nodejs
node --version

# ---------------------------------------------------------------------------
log "4/10  Service accounts and directories"
# ---------------------------------------------------------------------------
id -u hydra &>/dev/null || useradd --system --home "$APP_ROOT" --shell /usr/sbin/nologin hydra
getent group sftpusers >/dev/null || groupadd sftpusers

install -d -o hydra -g hydra "$APP_ROOT"
# SFTP root must be root-owned and non-writable — OpenSSH refuses to chroot
# into a directory the user can write to.
install -d -o root -g root -m 755 "$SFTP_ROOT"
install -d -o hydra -g hydra /var/log/hydra

# ---------------------------------------------------------------------------
log "5/10  SFTP server (chrooted, key-only, no shell)"
# ---------------------------------------------------------------------------
if ! grep -q "BEGIN HYDRA SFTP" /etc/ssh/sshd_config; then
cat >> /etc/ssh/sshd_config <<EOF

# === BEGIN HYDRA SFTP ===
# Per-merchant catalog drop. Chrooted, SFTP only, no shell, no port forwarding.
Match Group sftpusers
    ChrootDirectory ${SFTP_ROOT}/%u
    ForceCommand internal-sftp -u 0002
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication no
# === END HYDRA SFTP ===
EOF
fi
sshd -t || die "sshd config invalid — not restarting"
systemctl restart ssh || systemctl restart sshd

# Helper the console and provisioning call to create a merchant SFTP account.
cat > /usr/local/bin/hydra-sftp-user <<'SCRIPT'
#!/usr/bin/env bash
# hydra-sftp-user <username> <public-key-file>
# Creates a chrooted, key-only SFTP account for one site.
set -euo pipefail
USER_NAME="$1"; KEY_FILE="${2:-}"
SFTP_ROOT="${SFTP_ROOT:-/srv/hydra/sftp}"

id -u "$USER_NAME" &>/dev/null || \
  useradd --system --gid sftpusers --home "${SFTP_ROOT}/${USER_NAME}" \
          --shell /usr/sbin/nologin "$USER_NAME"

# Chroot target: root-owned, not group-writable. Subdirectories are writable.
install -d -o root -g root -m 755 "${SFTP_ROOT}/${USER_NAME}"
for d in incoming processed failed; do
  install -d -o "$USER_NAME" -g sftpusers -m 770 "${SFTP_ROOT}/${USER_NAME}/${d}"
done
# The ingest worker runs as hydra and must read and move what the merchant wrote.
setfacl -R -m u:hydra:rwx "${SFTP_ROOT}/${USER_NAME}"
setfacl -R -d -m u:hydra:rwx "${SFTP_ROOT}/${USER_NAME}"

if [[ -n "$KEY_FILE" ]]; then
  install -d -o "$USER_NAME" -g sftpusers -m 700 "/home/${USER_NAME}/.ssh"
  cat "$KEY_FILE" >> "/home/${USER_NAME}/.ssh/authorized_keys"
  chown "$USER_NAME:sftpusers" "/home/${USER_NAME}/.ssh/authorized_keys"
  chmod 600 "/home/${USER_NAME}/.ssh/authorized_keys"
fi
echo "sftp account ready: ${USER_NAME}"
SCRIPT
chmod +x /usr/local/bin/hydra-sftp-user

# ---------------------------------------------------------------------------
log "6/10  Application code"
# ---------------------------------------------------------------------------
# Clone (or fast-forward) straight from git. This is what makes redeploys a
# single command later: sudo hydra-update.
if [[ -d "$APP_ROOT/.git" ]]; then
  log "    updating existing checkout"
  sudo -u hydra git -C "$APP_ROOT" fetch --depth 1 origin "$BRANCH"
  sudo -u hydra git -C "$APP_ROOT" reset --hard "origin/$BRANCH"
else
  log "    cloning $REPO ($BRANCH)"
  rm -rf "$APP_ROOT"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_ROOT" \
    || die "clone failed. Private repo? Use a deploy key, or --repo git@github.com:..."
  chown -R hydra:hydra "$APP_ROOT"
fi
git config --global --add safe.directory "$APP_ROOT" || true

sudo -u hydra bash -c "cd $APP_ROOT/gateway && npm install --omit=dev --silent"
sudo -u hydra bash -c "cd $APP_ROOT/console && npm install --silent && npm run build"

# ---------------------------------------------------------------------------
log "7/10  Environment and migrations"
# ---------------------------------------------------------------------------
ENV_FILE="$APP_ROOT/gateway/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgresql://${DB_APP_USER}:${DB_APP_PASS}@127.0.0.1:5432/${DB_NAME}
PORT=8080
NODE_ENV=production
SFTP_ROOT=${SFTP_ROOT}

# --- fill these in before starting ---
ANTHROPIC_API_KEY=
INTENT_MODEL=claude-haiku-4-5-20251001
NARRATION_MODEL=claude-sonnet-4-6

EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=
EMBEDDING_MODEL=voyage-3
EMBEDDING_DIM=1024

JWT_SECRET=$(pwgen -s 48 1)
BOOTSTRAP_SECRET=$(pwgen -s 48 1)
CONSOLE_ORIGIN=https://${DOMAIN:-localhost}

STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

CANDIDATE_LIMIT=200
RESULT_FLOOR=8
QUERY_CACHE_TTL_SECONDS=3600
TOKEN_TTL_MINUTES=30
EMBED_BATCH=128
INGEST_POLL_MS=15000
EOF
  chown hydra:hydra "$ENV_FILE"; chmod 600 "$ENV_FILE"
else
  warn "$ENV_FILE exists, leaving it alone"
fi

# Migrations run as the OWNER (postgres), so RLS-forced tables can be created;
# the app then connects as hydra_app and is subject to those policies.
sudo -u postgres bash -c "cd $APP_ROOT && DATABASE_URL='postgresql://postgres@/${DB_NAME}?host=/var/run/postgresql' node gateway/scripts/migrate.js"

# Redeploy helper: pull, install, migrate, restart.
cat > /usr/local/bin/hydra-update <<'UPD'
#!/usr/bin/env bash
# Pull the latest code and restart. Safe to run repeatedly.
set -euo pipefail
APP_ROOT=/opt/hydra
BRANCH="${1:-main}"

echo "==> fetching"
sudo -u hydra git -C "$APP_ROOT" fetch --depth 1 origin "$BRANCH"
BEFORE=$(git -C "$APP_ROOT" rev-parse HEAD)
sudo -u hydra git -C "$APP_ROOT" reset --hard "origin/$BRANCH"
AFTER=$(git -C "$APP_ROOT" rev-parse HEAD)
echo "    $BEFORE -> $AFTER"

echo "==> dependencies"
sudo -u hydra bash -c "cd $APP_ROOT/gateway && npm install --omit=dev --silent"
sudo -u hydra bash -c "cd $APP_ROOT/console && npm install --silent && npm run build"

echo "==> migrations"
sudo -u postgres bash -c "cd $APP_ROOT && DATABASE_URL='postgresql://postgres@/hydra?host=/var/run/postgresql' node gateway/scripts/migrate.js"

echo "==> restart"
systemctl restart hydra-gateway hydra-ingest hydra-embed
sleep 2
systemctl is-active hydra-gateway hydra-ingest hydra-embed
curl -sf localhost:8080/health && echo && echo "==> ok"
UPD
chmod +x /usr/local/bin/hydra-update

sudo -u postgres psql -d "$DB_NAME" -q <<EOF
GRANT USAGE ON SCHEMA hydra TO ${DB_APP_USER};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hydra TO ${DB_APP_USER};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA hydra TO ${DB_APP_USER};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hydra TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hydra
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DB_APP_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA hydra
  GRANT USAGE, SELECT ON SEQUENCES TO ${DB_APP_USER};
ALTER ROLE ${DB_APP_USER} SET search_path = hydra, public;

-- Audit log is append-only. Revoking UPDATE and DELETE at the grant level means
-- even a compromised application cannot rewrite history.
REVOKE UPDATE, DELETE ON hydra.audit_log FROM ${DB_APP_USER};
EOF

# ---------------------------------------------------------------------------
log "8/10  systemd services"
# ---------------------------------------------------------------------------
write_unit() {
cat > "/etc/systemd/system/$1" <<EOF
[Unit]
Description=$2
After=network.target postgresql.service
Requires=postgresql.service

[Service]
Type=simple
User=hydra
Group=hydra
WorkingDirectory=${APP_ROOT}/gateway
EnvironmentFile=${APP_ROOT}/gateway/.env
ExecStart=/usr/bin/node $3
Restart=always
RestartSec=5
StandardOutput=append:/var/log/hydra/$4.log
StandardError=append:/var/log/hydra/$4.log
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/log/hydra ${SFTP_ROOT}

[Install]
WantedBy=multi-user.target
EOF
}

write_unit hydra-gateway.service "Hydra gateway API"      "src/server.js"        gateway
write_unit hydra-ingest.service  "Hydra SFTP ingest worker" "src/worker/ingest.js" ingest
write_unit hydra-embed.service   "Hydra embedding worker"   "src/worker/embed.js"  embed

systemctl daemon-reload
systemctl enable hydra-gateway hydra-ingest hydra-embed

cat > /etc/logrotate.d/hydra <<EOF
/var/log/hydra/*.log {
  daily
  rotate 14
  compress
  missingok
  notifempty
  copytruncate
}
EOF

# ---------------------------------------------------------------------------
log "9/10  nginx"
# ---------------------------------------------------------------------------
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/hydra <<EOF
server {
    listen 80;
    server_name ${SERVER_NAME};

    client_max_body_size 64m;   # bulk chunk HTTP fallback

    # Console SPA
    root ${APP_ROOT}/console/dist;
    index index.html;
    location / { try_files \$uri \$uri/ /index.html; }

    # Storefront + admin API
    location /v1/  { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }
    location /api/ { proxy_pass http://127.0.0.1:8080; include /etc/nginx/proxy_params; }
    location /health { proxy_pass http://127.0.0.1:8080; }
}
EOF
ln -sf /etc/nginx/sites-available/hydra /etc/nginx/sites-enabled/hydra
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

if [[ -n "$DOMAIN" && -n "$EMAIL" ]]; then
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
    || warn "certbot failed — TLS not configured, run it manually"
fi

# ---------------------------------------------------------------------------
log "10/10  Firewall and scheduled jobs"
# ---------------------------------------------------------------------------
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp  >/dev/null   # SSH + SFTP share this port
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

cat > /etc/cron.d/hydra <<EOF
0 3 * * * postgres psql -d ${DB_NAME} -c "SELECT hydra.hydra_purge(90)" >/dev/null 2>&1
0 4 1 * * postgres psql -d ${DB_NAME} -c "SELECT hydra.hydra_ensure_partitions(3)" >/dev/null 2>&1
EOF

CREDS="/root/hydra-credentials.txt"
cat > "$CREDS" <<EOF
Hydra platform — generated $(date -Is)

Database
  name     ${DB_NAME}
  app user ${DB_APP_USER}
  password ${DB_APP_PASS}
  url      postgresql://${DB_APP_USER}:${DB_APP_PASS}@127.0.0.1:5432/${DB_NAME}

Paths
  app      ${APP_ROOT}
  sftp     ${SFTP_ROOT}
  env      ${APP_ROOT}/gateway/.env
  logs     /var/log/hydra/

JWT_SECRET and BOOTSTRAP_SECRET are in the .env file.
EOF
chmod 600 "$CREDS"

cat <<EOF

═══════════════════════════════════════════════════════════════
 Installed. Services are enabled but NOT started.
═══════════════════════════════════════════════════════════════

 1. Add your API keys:
      sudo -u hydra nano ${APP_ROOT}/gateway/.env
      (ANTHROPIC_API_KEY and VOYAGE_API_KEY are both required)

 2. Start:
      sudo systemctl start hydra-gateway hydra-ingest hydra-embed

 3. Check:
      curl localhost:8080/health
      sudo journalctl -u hydra-gateway -f

 4. Verify tenant isolation BEFORE onboarding a second customer:
      sudo -u postgres psql -d ${DB_NAME} -c "\\
        SET ROLE ${DB_APP_USER}; \\
        SELECT set_config('hydra.tenant_id','<tenant-uuid>',false); \\
        SELECT count(*) FROM hydra.products;"
      It must return only that tenant's rows.

 5. Create a merchant SFTP account:
      sudo hydra-sftp-user acme_prod /path/to/their_key.pub

 Redeploy after pushing to git:
      sudo hydra-update

 Credentials: ${CREDS}

EOF
