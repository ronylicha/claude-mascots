#!/usr/bin/env bash
# Installe et démarre le relais permanent du correcteur d'usage (service systemd utilisateur, idempotent).
#
# Usage : install-usage-shim.sh [URL_AMONT] [PORT]
#   URL_AMONT : défaut = ANTHROPIC_BASE_URL lu dans $CC2_ENV_FILE (~/.config/cc2/env), sans charger la clé.
#   PORT      : défaut 4748 (boucle locale uniquement).
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${CC2_ENV_FILE:-$HOME/.config/cc2/env}"
PORT="${2:-4748}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/claude-usage-shim.service"

# Seule la ligne ANTHROPIC_BASE_URL est lue : la clé API ne doit pas entrer dans l'unité systemd.
UPSTREAM="${1:-$(sed -n -E 's/^(export )?ANTHROPIC_BASE_URL=["'\'']?([^"'\'' ]+)["'\'']?.*$/\2/p' "$ENV_FILE" 2>/dev/null | head -1)}"
[[ "$UPSTREAM" =~ ^https?:// ]] || { echo "amont introuvable : passer l'URL en argument ou définir ANTHROPIC_BASE_URL dans $ENV_FILE" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || { echo "port invalide : $PORT" >&2; exit 1; }

# Chemin résolu maintenant : sous systemd, le PATH ne contient pas nvm.
NODE_BIN="$(readlink -f "$(command -v node)")"
"$NODE_BIN" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)' \
  || { echo "Node >= 22.18 requis (trouvé : $("$NODE_BIN" --version))" >&2; exit 1; }

mkdir -p "$UNIT_DIR"
sed -e "s|@NODE@|$NODE_BIN|" -e "s|@APP_DIR@|$APP_DIR|" -e "s|@UPSTREAM@|$UPSTREAM|" -e "s|@PORT@|$PORT|" \
  "$APP_DIR/tap/claude-usage-shim.service" >"$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable --now claude-usage-shim.service
systemctl --user restart claude-usage-shim.service

# Le service doit répondre avant de déclarer l'installation réussie (pas de ✓ sur un crash loop).
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if health="$(curl -fsS --max-time 2 "http://127.0.0.1:$PORT/_usage-shim/health" 2>/dev/null)"; then
    echo "Relais installé : $UNIT_FILE"
    echo "Écoute : http://127.0.0.1:$PORT → $health"
    echo "Journal : journalctl --user -u claude-usage-shim -f"
    exit 0
  fi
  sleep 1
done
echo "le relais ne répond pas sur le port $PORT ; voir : journalctl --user -u claude-usage-shim -n 20" >&2
systemctl --user --no-pager status claude-usage-shim.service || true
exit 1
