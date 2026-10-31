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

# create_node/update_node auto-commit to this same repo (it's both the tool's
# source and its own self-hosted corpus) — without a git identity here those
# writes fail with "Committer identity unknown" the first time anyone uses
# the shared HTTP endpoint to write, not just read. Idempotent local config;
# it is also needed by the merge below, so it is set before the sync.
set_git_identity() {
  git config user.name "mnemosyne"
  git config user.email "mnemosyne@${SERVER_NAME}.globalclouddata.org"
}

# --- sync repo ---------------------------------------------------------------
# The running service commits every node it writes to THIS checkout and does not
# push (MNEMOSYNE_GIT_PUSH=false), so local main routinely holds commits that
# exist nowhere else — they are the team's memory. NEVER `git reset --hard` here:
# that is exactly what once discarded ~475 unpushed node commits. Instead keep a
# safety ref and merge origin/main in; on any problem stop and leave the checkout
# untouched rather than dropping work.
if [ -d "$INSTALL_DIR/.git" ]; then
  cd "$INSTALL_DIR"
  set_git_identity
  git fetch origin main
  git update-ref "refs/backup/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ)" HEAD
  if ! git merge --no-edit origin/main; then
    git merge --abort 2>/dev/null || true
    echo "✗ Could not merge origin/main into ${INSTALL_DIR}; nothing was discarded and the"
    echo "  running service was not touched. Resolve on the box, then re-run the deploy."
    exit 1
  fi
else
  git clone "$GIT_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
  set_git_identity
fi
# --- end sync repo -----------------------------------------------------------

# The pipeline already compiled packages/*/dist with devDependencies
# available — unpack that instead of building here. This box is RAM-starved
# and `npm ci --omit=dev` (below) strips out typescript, so there is no tsc
# to build with on-box anyway.
tar xzf /tmp/mnemosyne-dist.tar.gz -C "$INSTALL_DIR"
rm -f /tmp/mnemosyne-dist.tar.gz

npm ci --omit=dev --no-audit --no-fund

# Web-portal settings (MNEMOSYNE_SECRET, MNEMOSYNE_PUBLIC_URL, MNEMOSYNE_GITLAB_*,
# MNEMOSYNE_LOCAL_ADMIN_*) come from the pipeline as /tmp/mnemosyne-portal.env (built from
# masked CI/CD variables). If the pipeline sends none, whatever the current env file holds
# is kept, so a deploy never switches the portal off.
PORTAL_KEYS='MNEMOSYNE_SECRET|MNEMOSYNE_PUBLIC_URL|MNEMOSYNE_ALIAS_HOSTS|MNEMOSYNE_GITLAB_URL|MNEMOSYNE_GITLAB_CLIENT_ID|MNEMOSYNE_GITLAB_CLIENT_SECRET|MNEMOSYNE_LOCAL_ADMIN_USER|MNEMOSYNE_LOCAL_ADMIN_PASSWORD|MNEMOSYNE_LOCAL_ADMIN_PASSWORD_HASH'
PORTAL_ENV="$(mktemp)"
if [ -s /tmp/mnemosyne-portal.env ]; then
  grep -E "^(${PORTAL_KEYS})=" /tmp/mnemosyne-portal.env > "$PORTAL_ENV" || true
elif sudo test -f /etc/mnemosyne.env; then
  sudo grep -E "^(${PORTAL_KEYS})=" /etc/mnemosyne.env > "$PORTAL_ENV" || true
fi
rm -f /tmp/mnemosyne-portal.env

{
  cat <<EOF
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
  cat "$PORTAL_ENV"
} | sudo tee /etc/mnemosyne.env > /dev/null
rm -f "$PORTAL_ENV"
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
