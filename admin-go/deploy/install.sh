#!/usr/bin/env bash
# Installs (or updates) the Go admin on the server, ON the server, as the user that runs Mnemosyne. Nothing is restarted unless you say so:
#   deploy/install.sh <binary> <node dir> [--restart]
# The Node server keeps its data files; the Go program reads and writes the very same files, so there is nothing to migrate.
# ROLLBACK: put back the old unit (the backup this script makes next to it) and `systemctl daemon-reload && systemctl restart mnemosyne`.
set -euo pipefail
BIN="${1:?path of the mnemosyne-admin binary}"
NODE_DIR="${2:?directory of the Node installation, e.g. /opt/mnemosyne}"
UNIT=/etc/systemd/system/mnemosyne.service
# The user that runs Mnemosyne (the unit's User=). Set RUN_USER when this script is run as root, or the unit would run the server as root.
RUN_USER="${RUN_USER:-$(whoami)}"

sudo install -m 0755 "$BIN" /usr/local/bin/mnemosyne-admin
if [ -f "$UNIT" ] && [ ! -f "$UNIT.node-only" ]; then sudo cp "$UNIT" "$UNIT.node-only"; fi
sed -e "s#__NODE_DIR__#${NODE_DIR}#g" -e "s#__RUN_USER__#${RUN_USER}#g" "$(dirname "$0")/mnemosyne.service" | sudo tee "$UNIT" >/dev/null
sudo systemctl daemon-reload
echo "installed. The old unit is kept as $UNIT.node-only."
if [ "${3:-}" = "--restart" ]; then
  sudo systemctl restart mnemosyne
  sleep 3
  systemctl is-active mnemosyne
  curl -fsS "http://127.0.0.1:40001/mnemosyne/health" && echo
else
  echo "not restarted: run 'sudo systemctl restart mnemosyne' when nobody works and no automatic run is going."
fi
