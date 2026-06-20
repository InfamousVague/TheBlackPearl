#!/usr/bin/env bash
# One-time (idempotent) bootstrap of the VPS for the GhostWire social server.
#
# Installs Node + build deps, creates the `ghostwire` service user and install
# dir, writes a runtime .env (only if absent — generates an ADMIN_TOKEN), installs
# the systemd unit, and adds an Nginx vhost for social.ghostwire.tv reverse-proxying
# the local SOCIAL_PORT. Safe to re-run. Does NOT obtain a TLS cert (that needs the
# social.ghostwire.tv DNS record to exist first — run certbot afterwards).
#
# Reads VPS_USER/VPS_HOST/VPS_PORT/VPS_PW from ../../.env.apple (or env). Uses
# sshpass when VPS_PW is set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

APPLE_ENV="$ROOT/../.env.apple"
if [[ -f "$APPLE_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$APPLE_ENV"; set +a; fi

DEPLOY_USER="${DEPLOY_USER:-${VPS_USER:-}}"
DEPLOY_HOST="${DEPLOY_HOST:-${VPS_HOST:-}}"
DEPLOY_PORT="${DEPLOY_PORT:-${VPS_PORT:-22}}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/ghostwire-social}"
SERVICE_NAME="${SERVICE_NAME:-ghostwire-social}"
RUN_USER="${RUN_USER:-ghostwire}"
SOCIAL_PORT="${SOCIAL_PORT:-8791}"
SERVER_NAME="${SOCIAL_SERVER_NAME:-social.ghostwire.tv}"
PROXY_PREFIX="${SOCIAL_PROXY_PREFIX:-social}"
PUBLIC_URL="${SOCIAL_PUBLIC_URL:-https://ghostwire.tv/$PROXY_PREFIX}"

: "${DEPLOY_USER:?set VPS_USER in .env.apple}"
: "${DEPLOY_HOST:?set VPS_HOST in .env.apple}"

SSH_AUTH=()
if [[ -n "${VPS_PW:-}" ]]; then
  command -v sshpass >/dev/null || { echo "error: VPS_PW set but sshpass missing." >&2; exit 1; }
  export SSHPASS="$VPS_PW"
  SSH_AUTH=(sshpass -e)
fi
SSH_OPTS=(-p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new)
[[ -n "${DEPLOY_SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

echo "==> Provisioning $TARGET (port $SOCIAL_PORT, service $SERVICE_NAME)"

# Export the values the remote heredoc needs.
"${SSH_AUTH[@]}" ssh "${SSH_OPTS[@]}" "$TARGET" \
  "DEPLOY_PATH='$DEPLOY_PATH' RUN_USER='$RUN_USER' SERVICE_NAME='$SERVICE_NAME' SOCIAL_PORT='$SOCIAL_PORT' SERVER_NAME='$SERVER_NAME' PROXY_PREFIX='$PROXY_PREFIX' PUBLIC_URL='$PUBLIC_URL' bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
[ "$(id -u)" -eq 0 ] && SUDO= || SUDO=sudo

echo "-- Node + build deps"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 20 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y nodejs npm
fi
$SUDO apt-get install -y build-essential python3 rsync openssl >/dev/null
echo "node $(node --version) / npm $(npm --version)"

echo "-- service user + dirs"
id "$RUN_USER" >/dev/null 2>&1 || $SUDO useradd --system --create-home --home-dir "$DEPLOY_PATH" --shell /usr/sbin/nologin "$RUN_USER"
$SUDO mkdir -p "$DEPLOY_PATH/data"
$SUDO chown -R "$RUN_USER:$RUN_USER" "$DEPLOY_PATH"

echo "-- runtime .env"
if [ ! -f "$DEPLOY_PATH/.env" ]; then
  ADMIN="$(openssl rand -hex 32)"
  $SUDO tee "$DEPLOY_PATH/.env" >/dev/null <<ENV
HOST=127.0.0.1
PORT=$SOCIAL_PORT
DB_PATH=$DEPLOY_PATH/data/social.db
ADMIN_TOKEN=$ADMIN
PUBLIC_URL=$PUBLIC_URL
CORS_ORIGIN=*
TOKEN_TTL_SECONDS=604800
CHALLENGE_TTL_SECONDS=120
MAX_HANDLE_LEN=24
ENV
  $SUDO chown "$RUN_USER:$RUN_USER" "$DEPLOY_PATH/.env"
  $SUDO chmod 600 "$DEPLOY_PATH/.env"
  echo "   wrote $DEPLOY_PATH/.env (ADMIN_TOKEN generated)"
else
  echo "   kept existing $DEPLOY_PATH/.env"
fi

echo "-- systemd unit"
$SUDO tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<UNIT
[Unit]
Description=GhostWire social coordination server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$DEPLOY_PATH
EnvironmentFile=$DEPLOY_PATH/.env
ExecStart=/usr/bin/node $DEPLOY_PATH/dist/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DEPLOY_PATH/data

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true

echo "-- reverse proxy"
if systemctl is-active --quiet caddy && [ -f /etc/caddy/Caddyfile ]; then
  # Path-based on an existing TLS site (no new DNS/cert needed): /PREFIX/* -> node.
  if grep -q "handle_path /$PROXY_PREFIX/\*" /etc/caddy/Caddyfile; then
    echo "   Caddy /$PROXY_PREFIX/* block already present"
  else
    ts=$(date +%Y%m%d-%H%M%S)
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$ts"
    awk -v port="$SOCIAL_PORT" -v prefix="$PROXY_PREFIX" '
      !ins && /^[[:space:]]*handle[[:space:]]*\{/ {
        print "\thandle_path /" prefix "/* {";
        print "\t\treverse_proxy 127.0.0.1:" port;
        print "\t}";
        print "";
        ins=1
      }
      { print }
    ' "/etc/caddy/Caddyfile.bak-$ts" > /tmp/Caddyfile.gw
    if grep -q "handle_path /$PROXY_PREFIX/\*" /tmp/Caddyfile.gw && caddy validate --adapter caddyfile --config /tmp/Caddyfile.gw >/dev/null 2>&1; then
      cp /tmp/Caddyfile.gw /etc/caddy/Caddyfile
      systemctl reload caddy
      echo "   added Caddy handle_path /$PROXY_PREFIX/* -> 127.0.0.1:$SOCIAL_PORT (backup Caddyfile.bak-$ts)"
    else
      echo "   WARN: could not auto-edit Caddyfile. Add inside your site block:"
      echo "          handle_path /$PROXY_PREFIX/* { reverse_proxy 127.0.0.1:$SOCIAL_PORT }"
    fi
  fi
elif command -v nginx >/dev/null 2>&1 && systemctl is-active --quiet nginx; then
  echo "   nginx vhost ($SERVER_NAME -> 127.0.0.1:$SOCIAL_PORT)"
  $SUDO tee "/etc/nginx/sites-available/$SERVER_NAME" >/dev/null <<NGINX
map \$http_upgrade \$gw_social_upgrade { default upgrade; '' close; }
server {
    listen 80;
    server_name $SERVER_NAME;
    location / {
        proxy_pass http://127.0.0.1:$SOCIAL_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$gw_social_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NGINX
  $SUDO ln -sf "/etc/nginx/sites-available/$SERVER_NAME" "/etc/nginx/sites-enabled/$SERVER_NAME"
  $SUDO nginx -t && $SUDO systemctl reload nginx
else
  echo "   no active caddy/nginx detected; reverse-proxy 127.0.0.1:$SOCIAL_PORT yourself"
fi

echo "-- provisioning complete"
REMOTE

echo "==> Provisioned. Next: run deploy/deploy.sh to ship the app."
echo "    Endpoint (path-based on the existing TLS site): $PUBLIC_URL"
echo "    For a dedicated subdomain instead, add a DNS A record for $SERVER_NAME"
echo "    and a Caddy site block: $SERVER_NAME { reverse_proxy 127.0.0.1:$SOCIAL_PORT }"
