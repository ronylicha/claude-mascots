#!/usr/bin/env bash
# Intercepte le JSON que Claude Code envoie à la barre d'état, en garde une copie par session
# dans le spool de claude-mascots, puis le transmet tel quel à la vraie barre d'état.
#
# Usage (settings.json → statusLine.command) :
#   /chemin/vers/statusline-tap.sh <commande de barre d'état d'origine...>
#
# Garantie : quoi qu'il arrive ici (jq absent, disque plein…), la barre d'état d'origine
# reçoit le même stdin et son code de sortie est conservé.

set -u
SPOOL_DIR="${MASCOTS_HOME:-${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}/mascots}/spool"
UUID_PATTERN='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# `read` est intégré à bash : aucune dépendance externe pour lire l'entrée.
IFS= read -r -d '' payload || true

# Sous-shell : umask et trap restent confinés, la vraie barre d'état n'en hérite pas.
save_snapshot() (
  command -v jq >/dev/null 2>&1 || exit 0
  session_id="$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)" || exit 0
  # Le nom de fichier vient de l'entrée : on n'accepte qu'un UUID (pas de ../ possible).
  [[ "$session_id" =~ $UUID_PATTERN ]] || exit 0
  umask 077
  mkdir -p "$SPOOL_DIR" || exit 0
  tmp="$(mktemp "$SPOOL_DIR/.tmp.XXXXXX")" || exit 0
  trap 'rm -f "$tmp"' EXIT
  # Écriture puis renommage atomique : le démon ne lit jamais un fichier à moitié écrit.
  printf '%s' "$payload" >"$tmp" && mv -f "$tmp" "$SPOOL_DIR/$session_id.json"
)

save_snapshot 2>/dev/null

if [[ $# -eq 0 ]]; then
  exit 0
fi
printf '%s' "$payload" | "$@"
