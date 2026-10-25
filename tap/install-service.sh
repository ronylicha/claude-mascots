#!/usr/bin/env bash
# Installe et démarre le service systemd utilisateur de claude-mascots (idempotent).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Chemin résolu maintenant : sous systemd, le PATH ne contient pas nvm.
NODE_BIN="$(readlink -f "$(command -v node)")"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/claude-mascots.service"

"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)' \
  || { echo "Node >= 22.18 requis (trouvé : $("$NODE_BIN" --version))" >&2; exit 1; }

mkdir -p "$UNIT_DIR"
sed -e "s|@NODE@|$NODE_BIN|" -e "s|@APP_DIR@|$APP_DIR|" "$APP_DIR/tap/claude-mascots.service" >"$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable --now claude-mascots.service
systemctl --user restart claude-mascots.service

echo "Service installé : $UNIT_FILE (node : $NODE_BIN)"
echo "Journal : journalctl --user -u claude-mascots -f"
