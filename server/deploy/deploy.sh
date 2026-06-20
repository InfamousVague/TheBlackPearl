#!/usr/bin/env bash
# Build the GhostWire social server locally and ship it to your VPS.
#
# Connection details are read from (precedence high -> low):
#   1. deploy/.env    (DEPLOY_* overrides + DEPLOY_PATH / SERVICE_NAME / RUN_USER)
#   2. ../../.env.apple  (VPS_USER / VPS_HOST / VPS_PORT / VPS_PW)
#
# If VPS_PW (a password) is present, sshpass is used; otherwise key auth. Run the
# one-time provisioning first (deploy/provision.sh) so Node, the service user,
# the systemd unit and the Nginx vhost exist. This script then builds dist/,
# rsyncs the app, runs `npm ci --omit=dev` on the VPS (compiling the native
# better-sqlite3 binding there), and restarts the service. It never touches the
# VPS .env or data/ directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
cd "$ROOT"

# Optional non-secret overrides.
if [[ -f "$HERE/.env" ]]; then set -a; # shellcheck disable=SC1090
  source "$HERE/.env"; set +a; fi
# Credentials (gitignored repo-root env shared with the signing flow).
APPLE_ENV="$ROOT/../.env.apple"
if [[ -f "$APPLE_ENV" ]]; then set -a; # shellcheck disable=SC1090
  source "$APPLE_ENV"; set +a; fi

DEPLOY_USER="${DEPLOY_USER:-${VPS_USER:-}}"
DEPLOY_HOST="${DEPLOY_HOST:-${VPS_HOST:-}}"
DEPLOY_PORT="${DEPLOY_PORT:-${VPS_PORT:-22}}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/ghostwire-social}"
SERVICE_NAME="${SERVICE_NAME:-ghostwire-social}"
RUN_USER="${RUN_USER:-ghostwire}"

: "${DEPLOY_USER:?set VPS_USER (in .env.apple) or DEPLOY_USER (in deploy/.env)}"
: "${DEPLOY_HOST:?set VPS_HOST (in .env.apple) or DEPLOY_HOST (in deploy/.env)}"

# Transport: password (sshpass) vs key.
SSH_AUTH=()
if [[ -n "${VPS_PW:-}" ]]; then
  command -v sshpass >/dev/null || { echo "error: VPS_PW set but sshpass missing (brew install sshpass)." >&2; exit 1; }
  export SSHPASS="$VPS_PW"
  SSH_AUTH=(sshpass -e)
fi
SSH_OPTS=(-p "$DEPLOY_PORT" -o StrictHostKeyChecking=accept-new)
[[ -n "${DEPLOY_SSH_KEY:-}" ]] && SSH_OPTS+=(-i "$DEPLOY_SSH_KEY")
RSYNC_SSH="${SSH_AUTH[*]} ssh ${SSH_OPTS[*]}"
TARGET="$DEPLOY_USER@$DEPLOY_HOST"

run_ssh() { "${SSH_AUTH[@]}" ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

echo "==> Building TypeScript locally"
npm ci
npm run build

echo "==> Syncing app to $TARGET:$DEPLOY_PATH"
# Ship sources/build + manifests; never the local .env, data/, or node_modules.
rsync -avz --delete -e "$RSYNC_SSH" \
  --exclude node_modules/ \
  --exclude data/ \
  --exclude .env \
  --exclude deploy/.env \
  dist package.json package-lock.json tsconfig.json \
  "$TARGET:$DEPLOY_PATH/"

echo "==> Installing production deps + restarting on the VPS"
run_ssh "bash -s" <<REMOTE
set -euo pipefail
cd "$DEPLOY_PATH"
npm ci --omit=dev
# The service runs as a less-privileged user; ensure it can read the sync.
if id "$RUN_USER" >/dev/null 2>&1; then chown -R "$RUN_USER:$RUN_USER" "$DEPLOY_PATH"; fi
if [ "\$(id -u)" -eq 0 ]; then SUDO=; else SUDO=sudo; fi
\$SUDO systemctl restart "$SERVICE_NAME"
sleep 1
\$SUDO systemctl --no-pager --lines=0 status "$SERVICE_NAME" || true
REMOTE

echo "==> Done. Verify on the VPS:"
echo "    curl -s -H 'Host: social.ghostwire.tv' http://127.0.0.1/v1/health"
