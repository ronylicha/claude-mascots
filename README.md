# Claude Mascots

Chaque session **Claude Code** ou **Codex** (CLI, `codex exec`, Codex Desktop / VS Code) active sur la
machine devient un **personnage en pixel art** qui montre ce qu'elle fait (lire, écrire, lancer une
commande, chercher, déléguer, réfléchir, dormir), combien elle consomme de tokens, à quel point son
contexte est rempli — et chaque troupe s'inquiète quand le **quota de son compte** (Anthropic ou OpenAI)
s'épuise. Affichage dans le navigateur et sur l'écran **ESP32-2432S028** (« Cheap Yellow Display »).

```
 ~/.claude/sessions/<pid>.json ──┐   (qui est vivant, occupé ?)
 ~/.claude/projects/…/<id>.jsonl ┼─► démon Node ──► http://127.0.0.1:4747  (SSE)
 ~/.claude/mascots/spool/<id>.json┘   (1 s)    └──► port série 115200 ──► ESP32 (320x240)
        ▲ coût, contexte, quota       ▲
 tap/statusline-tap.sh (intercale la barre d'état existante)
 ~/.codex/sessions/…/rollout-*.jsonl ┘ (tenu ouvert par un processus codex = session vivante)
```

## Prérequis

| Composant | Version | Pourquoi |
|-----------|---------|----------|
| Node.js | ≥ 22.18 | exécution du TypeScript sans transpilation (`node fichier.ts`) |
| pnpm | ≥ 9 | installation des outils de développement (TypeScript, types Node) |
| `jq` | — | utilisé par `tap/statusline-tap.sh` ; sans lui, la copie est ignorée et la barre d'état reste intacte |
| Linux avec `/proc` | — | détection des sessions Codex (descripteurs ouverts) ; sans `/proc`, seules les sessions Claude Code sont vues |
| PlatformIO (`pio`) | — | uniquement pour l'écran ESP32 : tests natifs, compilation, flash |

Aucune dépendance d'exécution : le démon n'utilise que la bibliothèque standard de Node.

## Démarrage

```bash
pnpm install            # dépendances de dev uniquement (TypeScript, types Node)
pnpm start              # ou : pnpm service:install  (service systemd utilisateur)
xdg-open http://127.0.0.1:4747
```

La barre d'état de Claude Code doit passer par le tap pour fournir coût, contexte et quota par
session. Dans `~/.claude/settings.json` :

```json
"statusLine": { "type": "command", "command": "/chemin/claude-mascots/tap/statusline-tap.sh <commande d'origine>" }
```

Le tap garde une copie du JSON (droits 600, nom = UUID validé) puis le transmet **inchangé** à la
commande d'origine ; sans commande, il ne fait que la copie.

### Sessions passant par un proxy Anthropic (`ANTHROPIC_BASE_URL`)

Certains proxys renseignent mal le champ `usage` des réponses. Mesuré sur ghostcli.cloud le
2026-10-25 : en streaming, `message_start` annonce `input_tokens: 0` et `message_delta` un
`output_tokens` ≈ 10 fois trop petit (653 tokens réels pour 66 annoncés), alors que
`/v1/messages/count_tokens` du même proxy compte juste. Claude Code en déduit un contexte à 0 %,
un coût faux et ne compacte jamais ; le journal `.jsonl` et la barre d'état propagent ces zéros.

`tap/usage-shim.ts` est un mandataire local (boucle locale, port éphémère, zéro dépendance) à placer
entre Claude Code et le proxy : il relaie tout tel quel et ne corrige que `usage` des réponses de
`POST /v1/messages`, à partir de `count_tokens` (entrée gardée si > 0, sinon comptée ; sortie = max
du comptage et de l'annonce ; cache à 0 faute d'information). `message_start` et `message_delta` sont
retenus au plus 4 s le temps du comptage ; si le comptage échoue, le flux passe non corrigé.

```bash
ANTHROPIC_BASE_URL=https://proxy.example ANTHROPIC_API_KEY=… \
  node tap/usage-shim.ts -- claude            # ou : --upstream URL, --hold-ms N, --trace
```

`--trace` (ou `CLAUDE_MASCOTS_USAGE_SHIM_TRACE=1`) écrit une ligne par appel API sur stderr : modèle,
`max_tokens`, statut amont, résultats de `count_tokens` — jamais le contenu des messages.

**Relais permanent.** `pnpm shim:install` installe le service systemd utilisateur `claude-usage-shim`
(`tap/install-usage-shim.sh`, amont lu dans `~/.config/cc2/env` ou passé en argument, port 4748 sur
127.0.0.1 uniquement). Le service ne détient aucun secret : la clé API reste chez le client et ne fait
que traverser. `GET /_usage-shim/health` répond `{"ok":true,"upstream":…}` ; tout le reste part à
l'amont. Tout client dont `ANTHROPIC_BASE_URL=http://127.0.0.1:4748` en bénéficie. La commande `cc2`
l'utilise quand il répond et annonce le même amont que ses identifiants, sinon elle lance un
correcteur pour la session (`CC2_NO_SERVICE=1` force ce repli).

```bash
pnpm shim:install                              # ou : bash tap/install-usage-shim.sh https://proxy.example 4748
journalctl --user -u claude-usage-shim -f
```

**Fenêtre de contexte et compaction.** Le catalogue `/v1/models` de ghostcli annonce 256 k pour
`claude-fable-5.1` et 1 M pour `claude-fable-5.1[1m]`, mais le proxy a accepté 315 k, 621 k et
1 050 762 tokens sur l'id simple sans jamais répondre « prompt is too long » (mesures du 2026-10-25) ; ghostcli a
confirmé ensuite sur son Discord que tous ses modèles ont une fenêtre de 1 M, le catalogue est donc faux.
Claude Code ne peut pas apprendre la limite par l'erreur API : la compaction doit être proactive.
La commande `cc2` de ce poste pose `CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000` (fenêtre effective
880 000 sur le 1 M des modèles Claude 5) et `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (sélecteur
`/model`). Elle ne pose **pas** `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`, pourtant suggéré par la doc du
proxy : Claude Code croirait à 200 k et refuserait de démarrer ici (prompt de base ≈ 167 k tokens
+ 128 k de sortie réservée), sans même appeler le proxy. Avant le correcteur, la compaction ne se
déclenchait jamais pour une autre raison : `usage` à 0, donc un contexte toujours vu à 0 %.

Le démon, lui, reste honnête sans correcteur : un message sans aucun token d'entrée (ni direct ni
cache) est la signature d'un `usage` non transmis, la session est marquée `usageReliable: false`,
son contexte et son coût ne sont pas publiés (`x` et `c` à `-1` sur l'écran, « Non mesuré » dans le
navigateur) et la vue détaillée l'explique.

### Sessions Codex (OpenAI)

Codex n'a ni registre ni barre d'état : tout vient de son journal `~/.codex/sessions/AAAA/MM/JJ/rollout-<date>-<uuid>.jsonl`
(format mesuré le 2026-10-25 sur Codex CLI 0.157/0.164 et Codex Desktop 0.162/0.163). Le démon considère
qu'une session vit tant qu'un processus dont le nom contient `codex` garde le rollout ouvert
(`/proc/<pid>/fd`, balayé toutes les 3 s) : les archives `.jsonl.zst` que le daemon app-server tient aussi
ouvertes sont ignorées, de même que les fils de sous-agents (`source.subagent`), qui vivent dans le processus
de leur parent. Sans `/proc` (macOS), aucune session Codex n'est détectée.

Dans le rollout : `session_meta` (identité, dossier, version), `turn_context` (modèle), `task_started` /
`task_complete` (au travail ou au repos ; `*_approval_request` et `request_user_input` = attend l'humain),
`token_count` (totaux cumulés dont on ne compte que l'accroissement, dernier appel pour le contexte, fenêtre
du modèle, `rate_limits` du compte) et `response_item` (appels d'outils, réflexions). Les cellules JavaScript
de Codex Desktop (`exec`, `js`) sont classées d'après les `tools.<nom>(…)` qu'elles appellent. Le contexte
affiché est `(total − réflexion) / fenêtre` du dernier appel ; Codex soustrait une base dans son propre
indicateur, les deux chiffres diffèrent de quelques points. Pas de coût (abonnement) : « Inclus ».

Les fenêtres `primary`/`secondary` des rate limits n'ont pas de sens fixe (un abonnement Pro n'a qu'une
fenêtre de 10 080 min) : elles sont rangées par durée, ≤ 12 h dans « 5 h », au-delà dans « semaine ». Le
quota OpenAI est publié à part (`quotas.codex`) et ne colore que l'humeur des sessions Codex.

## Écran ESP32-2432S028

```bash
pnpm firmware:flash     # pio run -d firmware -e cyd -t upload
```

- **Branchement** : la version USB-C de la carte n'a pas les résistances CC de 5,1 kΩ ; un port USB-C
  de PC ne la voit donc pas (ni courant ni données). Utiliser un **port USB-A** avec un câble de
  **données** USB-A → USB-C, un adaptateur OTG USB-C → USB-A, ou le port micro-USB. La puce USB-série
  (CH340, `1a86:7523`) doit apparaître dans `lsusb` et créer `/dev/ttyUSB0`.
- Le démon détecte la carte seul (`/dev/serial/by-id`, `/dev/ttyACM*`, `/dev/ttyUSB*`) et s'y reconnecte.
- **Contrôleur d'écran** : le firmware pilote par défaut un **ST7789** (versions USB-C, écran
  TPM408-2.8). Les premières cartes micro-USB seules ont un **ILI9341** : compiler alors avec
  `-DMASCOTS_PANEL_ILI9341=1` et `-DMASCOTS_DEFAULT_INVERT=0`. Le mauvais pilote donne une image en
  portrait et retournée. La ligne `HELLO` indique le contrôleur (`panel=…/00009341` = ILI9341).
- **Bouton BOOT** : appui court = inverser les couleurs (le ST7789 en a besoin, c'est le réglage par
  défaut) ; appui long (≥ 0,8 s) = retourner l'écran ; appui très long (≥ 3 s) = recalibrer le tactile.
  Réglages mémorisés en flash.
- **LED RGB** : vert = calme, bleu qui respire = au travail, jaune = quota sous tension,
  rouge = quota ou contexte épuisé, éteinte = PC muet.
- **Chambres** : chaque session vit dans sa chambre (64×40 pixels logiques, agrandie à l'échelle
  entière). La fenêtre suit l'heure du PC (jour, crépuscule, nuit), l'écran de l'ordinateur montre l'outil
  en cours, et la pose change : assis au bureau (travaille), debout (repos, bulle « ! » quand la session
  attend), couché (dort). Rendu de référence : `web/sprites.js`.
- **Grille** : 1 session = grande chambre (échelle 4) ; 2 = deux colonnes (échelle 2) ; 3–4 = 2×2
  (échelle 2, une ligne de texte) ; 5–6 = 3×2 (échelle 1, texte minimal). Le bandeau quota reste en haut :
  il montre le compte Claude ou le compte Codex, et alterne toutes les 5 s quand les deux sont en jeu.
- **Tactile** (XPT2046, bus SPI séparé : CLK 25, MOSI 32, MISO 39, CS 33, IRQ 36) : un tap sur une
  chambre ouvre la **vue détaillée** de la session (activité et outil, modèle, projet, durée, coût, tours,
  jauge de contexte, tokens, courbe des 30 dernières minutes, appels par catégorie d'outil). La flèche
  « < » en haut à gauche (zone de 64×34 pixels) ramène à la grille ; si la session disparaît, la carte
  revient seule à la grille. Chaque tap est signalé au PC par une ligne `TOUCH` (journal du démon).
- **Calibration du tactile** : le tactile marche dès le démarrage grâce à une calibration par défaut
  mesurée sur la variante ST7789 (axe X brut inversé, voir `include/display.h`). Si les taps tombent à côté
  (autre variante de la carte), maintenir BOOT 3 s : quatre croix à toucher (30 s par croix, puis abandon),
  résultat mémorisé (`Preferences`, espace `mascots`, clé `tcal`) et prioritaire sur la calibration par
  défaut. Elle est exprimée dans le repère natif du panneau : elle reste valable quand BOOT retourne
  l'écran (rotations 1 et 3).

## Vérifications

```bash
pnpm check   # typecheck + tests démon + en-tête sprites à jour + tests du décodeur firmware sur PC
```

## Personnaliser

- Sprites : `shared/sprites.json` (chambre 64×40, palette indexée), puis `pnpm sprites` pour le firmware.
  Toute règle de rendu changée dans `web/sprites.js` doit l'être dans `firmware/src/scene.cpp`.
- Seuils d'humeur : `MOOD_THRESHOLDS` dans `host/src/domain/behavior.ts`.
- Port, délais, emplacements : `host/src/config.ts` (`MASCOTS_PORT`, `MASCOTS_HOME`, `CLAUDE_CONFIG_DIR`).

## Sécurité

Serveur sur `127.0.0.1` uniquement, en-tête `Host` vérifié (anti DNS-rebinding), CSP stricte, GET seul.
Les fichiers `~/.claude/sessions/*.key` ne sont jamais lus ; aucun jeton OAuth n'est manipulé (le
quota vient du JSON que Claude Code fournit lui-même à sa barre d'état).

## Organisation du dépôt

```
host/src/      démon : sources (Claude Code, Codex), domaine (collector, behavior, avatar), transports (HTTP/SSE, série), correcteur d'usage
host/test/     tests `node --test` (144)
web/           tableau de bord vanilla (ES modules, sans build)
firmware/      ESP32-2432S028 (PlatformIO, LovyanGFX, ArduinoJson) + tests natifs Unity (32)
shared/        sprites.json, source unique des sprites (web et firmware)
tap/           tap de barre d'état, correcteur d'usage, unités systemd et installeurs
tools/         génération de l'en-tête de sprites du firmware
docs/          architecture.md, serial-protocol.md
```

## Documentation

- [docs/architecture.md](docs/architecture.md) : flux de données, couches, invariants, format des journaux Codex.
- [docs/serial-protocol.md](docs/serial-protocol.md) : protocole série v2 PC → ESP32.
- [CHANGELOG.md](CHANGELOG.md).

## Licence

[MIT](LICENSE) — Rony Licha.
