#!/usr/bin/env bash
# Mnemosyne installer for a Linux server with systemd.
#
#   sudo ./install.sh                        install (or upgrade) with the defaults
#   sudo ./install.sh --public-url https://mnemosyne.example.com --listen 127.0.0.1:40001
#   ./install.sh --help
#
# It installs the server (Node.js) and the admin program (Go, compiled) from this release, creates a data directory that is a git repository
# for the notes, writes /etc/mnemosyne.env ONCE (an existing file is never touched, so an upgrade keeps your settings and secrets), installs
# a systemd unit and starts it. Upgrading = unpack the newer release and run this script again: data and settings stay.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERSION="$(cat "$HERE/VERSION" 2>/dev/null || echo unknown)"

INSTALL_DIR=/opt/mnemosyne          # the program files (replaced on every upgrade)
DATA_DIR=/var/lib/mnemosyne         # the notes (a git repository) and what the server keeps next to them
BIN_DIR=/usr/local/bin
ENV_FILE=/etc/mnemosyne.env
UNIT_FILE=/etc/systemd/system/mnemosyne.service
RUN_USER=mnemosyne
LISTEN=127.0.0.1:40001              # where the admin program (the front door) listens; put a reverse proxy with TLS in front of it
PUBLIC_URL=""                       # the address people type, no path: https://mnemosyne.example.com[:port]
ADMIN_USER=admin
ADMIN_PASSWORD=""                   # generated when empty (printed once)
SYSTEMD=1
START=1

usage() {
  cat <<USAGE
Mnemosyne ${VERSION} installer

  --public-url URL       the address people use, without a path (default: http://<this host>:<port of --listen>)
  --listen HOST:PORT     where the program listens (default ${LISTEN}); use 0.0.0.0:40001 to reach it without a proxy (no TLS!)
  --dir DIR              program files (default ${INSTALL_DIR})
  --data DIR             notes and data (default ${DATA_DIR})
  --user NAME            system user that runs it (default ${RUN_USER}, created when missing)
  --admin-user NAME      built-in admin account (default ${ADMIN_USER}); only used when the env file is created
  --admin-password PW    its password (default: a random one, printed once); only used when the env file is created
  --env-file FILE        settings file (default ${ENV_FILE}); never overwritten
  --no-systemd           do not create a user or a unit (for a test or a container): installs the files and prints how to start it
  --no-start             install but do not start
  -h, --help             this text
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL="${2:?}"; shift 2 ;;
    --listen) LISTEN="${2:?}"; shift 2 ;;
    --dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    --data) DATA_DIR="${2:?}"; shift 2 ;;
    --user) RUN_USER="${2:?}"; shift 2 ;;
    --admin-user) ADMIN_USER="${2:?}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:?}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?}"; shift 2 ;;
    --unit-file) UNIT_FILE="${2:?}"; shift 2 ;;
    --bin-dir) BIN_DIR="${2:?}"; shift 2 ;;
    --no-systemd) SYSTEMD=0; START=0; shift ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1"; usage; exit 2 ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---- checks -----------------------------------------------------------------------------------------------------------------
[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU: $(uname -m) (amd64 and arm64 are included)" ;;
esac
if [ "$SYSTEMD" = 1 ]; then
  [ "$(id -u)" = 0 ] || die "run as root: sudo ./install.sh"
  command -v systemctl >/dev/null || die "systemd is needed (or use --no-systemd)"
fi
command -v node >/dev/null || die "Node.js 20 or newer is needed (https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is needed (found $(node --version))"
command -v npm >/dev/null || die "npm is needed (it comes with Node.js)"
command -v git >/dev/null || die "git is needed (the notes are kept in a git repository)"
command -v curl >/dev/null || die "curl is needed"
[ -f "$HERE/bin/mnemosyne-admin-linux-$ARCH" ] || die "this directory is not an unpacked Mnemosyne release (bin/mnemosyne-admin-linux-$ARCH is missing)"
[ -d "$HERE/server/packages/server/dist" ] || die "this directory is not an unpacked Mnemosyne release (server/ is missing)"

say "Mnemosyne ${VERSION} for linux/${ARCH} - program files: ${INSTALL_DIR}, data: ${DATA_DIR}"
( cd "$HERE/bin" && sha256sum --check --ignore-missing --quiet SHA256SUMS ) || die "the checksum of a binary does not match: the download is damaged"

# ---- the user and the directories -----------------------------------------------------------------------------------------
if [ "$SYSTEMD" = 1 ] && ! id "$RUN_USER" >/dev/null 2>&1; then
  say "creating the system user ${RUN_USER}"
  useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
fi
mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$BIN_DIR"

# ---- the server ------------------------------------------------------------------------------------------------------------
say "installing the server (npm ci: this downloads the dependencies once)"
rm -rf "$INSTALL_DIR/packages/core/dist" "$INSTALL_DIR/packages/server/dist"   # a file that no longer exists in this release must not stay behind
mkdir -p "$INSTALL_DIR"
cp -a "$HERE/server/." "$INSTALL_DIR/"
( cd "$INSTALL_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error )

# ---- the admin program ---------------------------------------------------------------------------------------------------
say "installing the admin program"
install -m 0755 "$HERE/bin/mnemosyne-admin-linux-$ARCH" "$BIN_DIR/mnemosyne-admin.new"
mv -f "$BIN_DIR/mnemosyne-admin.new" "$BIN_DIR/mnemosyne-admin"

# ---- the data directory: a git repository for the notes -----------------------------------------------------------------
if [ ! -d "$DATA_DIR/.git" ]; then
  say "creating the notes repository in ${DATA_DIR}"
  git -C "$DATA_DIR" init -q -b main
  mkdir -p "$DATA_DIR/nodes"
  touch "$DATA_DIR/nodes/.gitkeep"
  git -C "$DATA_DIR" add -A
  git -C "$DATA_DIR" -c user.name=mnemosyne -c user.email=mnemosyne@localhost commit -q -m "mnemosyne: empty notes repository"
fi
git -C "$DATA_DIR" config user.name >/dev/null 2>&1 || git -C "$DATA_DIR" config user.name mnemosyne
git -C "$DATA_DIR" config user.email >/dev/null 2>&1 || git -C "$DATA_DIR" config user.email mnemosyne@localhost
if [ "$SYSTEMD" = 1 ]; then chown -R "$RUN_USER:$RUN_USER" "$DATA_DIR"; fi

# ---- the settings: written once ----------------------------------------------------------------------------------------------
PORT="${LISTEN##*:}"
if [ -z "$PUBLIC_URL" ]; then
  H="$(hostname -f 2>/dev/null || hostname)"
  [ "${LISTEN%%:*}" = "127.0.0.1" ] && H=localhost
  PUBLIC_URL="http://${H}:${PORT}"
fi
NEW_ENV=0
if [ -f "$ENV_FILE" ]; then
  say "keeping your settings in ${ENV_FILE}"
else
  NEW_ENV=1
  say "writing ${ENV_FILE}"
  rand() { head -c 48 /dev/urandom | base64 | tr -d '/+=\n' | head -c "$1"; }
  [ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD="$(rand 20)"
  umask 077
  cat > "$ENV_FILE" <<ENV
# Mnemosyne settings, written by install.sh ${VERSION}. Keep this file private (it holds the secret that seals the stored API keys).
MNEMOSYNE_REPO=${DATA_DIR}
MNEMOSYNE_BASE_PATH=/mnemosyne
MNEMOSYNE_EMBED_BACKEND=hash
MNEMOSYNE_EMBED_DIM=256
MNEMOSYNE_GIT_PUSH=false
MNEMOSYNE_SECRET=$(rand 48)
MNEMOSYNE_PUBLIC_URL=${PUBLIC_URL}
# the built-in administrator (GitLab sign-in for the admin area needs a licence; see the README)
MNEMOSYNE_LOCAL_ADMIN_USER=${ADMIN_USER}
MNEMOSYNE_LOCAL_ADMIN_PASSWORD=${ADMIN_PASSWORD}
# GitLab sign-in of the documentation portal (see docs/self-hosting.md):
# MNEMOSYNE_GITLAB_URL=https://gitlab.example.com
# MNEMOSYNE_GITLAB_CLIENT_ID=
# MNEMOSYNE_GITLAB_CLIENT_SECRET=
ENV
  chmod 600 "$ENV_FILE"
fi

NODE_BIN="$(command -v node)"
if [ "$SYSTEMD" = 1 ]; then
  say "installing the systemd unit ${UNIT_FILE}"
  [ -f "$UNIT_FILE" ] && cp -a "$UNIT_FILE" "$UNIT_FILE.before-${VERSION}"
  cat > "$UNIT_FILE" <<UNIT
# Mnemosyne ${VERSION}: the admin program is the front door; it starts the server as its child on 127.0.0.1:40002.
[Unit]
Description=Mnemosyne - self-hosted AI team memory
After=network.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
Environment=MNEMOSYNE_ADMIN_LISTEN=${LISTEN}
Environment=MNEMOSYNE_UPSTREAM=http://127.0.0.1:40002
Environment=MNEMOSYNE_NODE_DIR=${INSTALL_DIR}
Environment="MNEMOSYNE_NODE_CMD=${NODE_BIN} ${INSTALL_DIR}/packages/server/dist/bin/mnemosyne.js serve --http"
WorkingDirectory=${INSTALL_DIR}
ExecStart=${BIN_DIR}/mnemosyne-admin
Restart=on-failure
RestartSec=5
User=${RUN_USER}
NoNewPrivileges=true
KillMode=control-group

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable mnemosyne >/dev/null 2>&1 || true
  if [ "$START" = 1 ]; then
    say "starting Mnemosyne"
    systemctl restart mnemosyne
    ok=0
    for _ in $(seq 1 60); do
      if curl -fsS "http://${LISTEN/0.0.0.0/127.0.0.1}/mnemosyne/health" >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    [ "$ok" = 1 ] || { systemctl --no-pager status mnemosyne | tail -15 || true; die "it did not answer on ${LISTEN} within a minute: journalctl -u mnemosyne"; }
  fi
else
  cat <<MANUAL

Files are in place; nothing was started (--no-systemd). To start it by hand:

  set -a; . ${ENV_FILE}; set +a
  MNEMOSYNE_ADMIN_LISTEN=${LISTEN} MNEMOSYNE_UPSTREAM=http://127.0.0.1:40002 MNEMOSYNE_NODE_DIR=${INSTALL_DIR} \\
  MNEMOSYNE_NODE_CMD="${NODE_BIN} ${INSTALL_DIR}/packages/server/dist/bin/mnemosyne.js serve --http" \\
  ${BIN_DIR}/mnemosyne-admin
MANUAL
fi

# ---- done --------------------------------------------------------------------------------------------------------------------
echo
printf '\033[32m✓ Mnemosyne %s is installed.\033[0m\n' "$VERSION"
echo "  Admin area:   ${PUBLIC_URL}/mnemosyne/admin/"
if [ "$NEW_ENV" = 1 ]; then
  echo "  Sign in as:   ${ADMIN_USER}   password: ${ADMIN_PASSWORD}      (saved in ${ENV_FILE}; change it there)"
fi
echo "  MCP endpoint: ${PUBLIC_URL}/mnemosyne/mcp"
echo "  Health:       curl http://${LISTEN/0.0.0.0/127.0.0.1}/mnemosyne/health"
echo "  Logs:         journalctl -u mnemosyne -f"
echo
echo "  Next: put a reverse proxy with TLS in front of ${LISTEN}, then add your AI provider under Admin -> LLM"
echo "  (free for up to 4 people; a licence key lifts the limit - see README.txt)."
