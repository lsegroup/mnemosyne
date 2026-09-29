#!/usr/bin/env bash
# Runs ON the target server (invoked over SSH by .gitlab-ci.yml's deploy_mnemosyne_* job).
# Clones/updates the mnemosyne repo in place, builds it, and (re)starts it as a systemd
# service bound to 127.0.0.1 only — it is reached from outside via the box's existing
# nginx, never by opening a new firewall port (see mnemosyne self-hosting doc: this box
# has a ufw tripwire cron that reverts unrecognized rules).
set -euo pipefail

SERVER_NAME="$1"
DATACENTER="$2"
ENVIRONMENT="$3"
INSTALL_DIR="$4"
SERVICE_NAME="$5"
GIT_URL="$6"
HTTP_PORT="${7:-40001}"
RUN_USER="$(whoami)"

echo "==> Deploying mnemosyne to ${SERVER_NAME} (${DATACENTER}/${ENVIRONMENT}) at ${INSTALL_DIR}"

sudo mkdir -p "$INSTALL_DIR"
sudo chown "$RUN_USER" "$INSTALL_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  git fetch origin main
  git reset --hard origin/main
else
  git clone "$GIT_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# create_node/update_node auto-commit to this same repo (it's both the tool's
# source and its own self-hosted corpus) — without a git identity here those
# writes fail with "Committer identity unknown" the first time anyone uses
# the shared HTTP endpoint to write, not just read. Idempotent; local config,
# survives `git reset --hard` (that only touches the working tree/index).
git config user.name "mnemosyne"
git config user.email "mnemosyne@${SERVER_NAME}.globalclouddata.org"

# The pipeline already compiled packages/*/dist with devDependencies
# available — unpack that instead of building here. This box is RAM-starved
# and `npm ci --omit=dev` (below) strips out typescript, so there is no tsc
# to build with on-box anyway.
tar xzf /tmp/mnemosyne-dist.tar.gz -C "$INSTALL_DIR"
rm -f /tmp/mnemosyne-dist.tar.gz

npm ci --omit=dev --no-audit --no-fund

sudo tee /etc/mnemosyne.env > /dev/null <<EOF
MNEMOSYNE_REPO=$INSTALL_DIR
MNEMOSYNE_HTTP_HOST=127.0.0.1
MNEMOSYNE_HTTP_PORT=$HTTP_PORT
MNEMOSYNE_BASE_PATH=/mnemosyne
# No MNEMOSYNE_BEARER_TOKEN: internal network only, matches the sibling
# CodeGraph MCP server on this same box, which also runs unauthenticated.
MNEMOSYNE_EMBED_BACKEND=hash
MNEMOSYNE_EMBED_DIM=256
MNEMOSYNE_GIT_PUSH=false
EOF
sudo chmod 600 /etc/mnemosyne.env

sed -e "s#__INSTALL_DIR__#${INSTALL_DIR}#g" -e "s#__RUN_USER__#${RUN_USER}#g" \
  "$INSTALL_DIR/deploy/mnemosyne.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"
sleep 2
sudo systemctl is-active --quiet "$SERVICE_NAME" || { echo "✗ ${SERVICE_NAME} failed to start"; sudo journalctl -u "$SERVICE_NAME" --no-pager -n 40; exit 1; }

# Reindex via the RUNNING service's own REST endpoint, not a separate CLI
# process. A bare `node .../mnemosyne.js reindex` here doesn't inherit
# /etc/mnemosyne.env (it's a plain shell command, nothing sources that file),
# so it silently re-resolved a DIFFERENT embedder (fastembed, 384-dim,
# installed as an optionalDependency) than the service's configured
# MNEMOSYNE_EMBED_BACKEND=hash (256-dim) — dropping and recreating nodes_vec
# at the wrong dimension out from under the already-running service on every
# deploy. Hitting the service's own endpoint means there is exactly one
# source of truth for embedder config, permanently, not two that can drift.
curl -sf -X POST "http://127.0.0.1:${HTTP_PORT}/mnemosyne/reindex" \
  -H "Content-Type: application/json" -d '{}' && echo

echo "✓ mnemosyne service active. Local health check:"
curl -sf "http://127.0.0.1:${HTTP_PORT}/mnemosyne/health" && echo

# Drop the nginx location block as a snippet ONLY — never edit the live GitLab
# nginx config from this script. GitLab's nginx serves the whole box; a bad
# automatic edit there takes GitLab down for everyone. Wiring the one-line
# `include` into sites-available/gitlab-external is a deliberate manual step,
# done once, reviewed by a human.
sudo tee /etc/nginx/snippets/mnemosyne-location.conf > /dev/null <<EOF
location /mnemosyne/ {
    proxy_pass http://127.0.0.1:${HTTP_PORT}/mnemosyne/;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host \$host;
    proxy_buffering off;
}
EOF
echo "==> Wrote /etc/nginx/snippets/mnemosyne-location.conf"
echo "==> ONE-TIME MANUAL STEP still required: add"
echo "        include snippets/mnemosyne-location.conf;"
echo "    inside the server{} block of /etc/nginx/sites-available/gitlab-external, then:"
echo "        sudo nginx -t && sudo systemctl reload nginx"
