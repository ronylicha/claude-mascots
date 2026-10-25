# Changelog

Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions [SemVer](https://semver.org/lang/fr/).

## [0.1.0] - 2026-10-25

### Added
- Démon Node (TypeScript natif, zéro dépendance) qui lit les sessions Claude Code (registre, journal, barre d'état) et Codex (rollouts tenus ouverts par un processus `codex`) et publie un état par SSE.
- Tableau de bord web en pixel art : une chambre par session, activité, humeur, contexte, tokens, outils, deux groupes de quota (comptes Anthropic et OpenAI).
- Firmware ESP32-2432S028 (protocole série v2) : grille de chambres, vue détaillée tactile, LED d'état, bandeau de quota par compte.
- Correcteur d'usage `tap/usage-shim.ts` pour les proxys Anthropic qui renseignent mal `usage` (mode par session ou relais permanent systemd).
- Tap de barre d'état `tap/statusline-tap.sh` (coût, contexte, quota par session).

### Fixed
- Arrêt du démon bloqué 90 s par une lecture bloquante du port série (lecture via `tty.ReadStream`).
