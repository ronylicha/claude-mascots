# Architecture

```
 ~/.claude/sessions/<pid>.json ──┐  registre (vivant ? busy/idle ?)
 ~/.claude/projects/…/<id>.jsonl ┼─► Collector (1 s) ──► DashboardServer  /api/state + /events (SSE)
 ~/.claude/mascots/spool/<id>.json┘  coût, contexte, quota   └► SerialBridge ─► ESP32 (JSON v2, 1 ligne/trame)
        ▲ écrit par tap/statusline-tap.sh (intercale la vraie barre d'état)
 ~/.codex/sessions/…/rollout-*.jsonl ─► Collector (rollout tenu ouvert par un processus `codex` = session vivante)

 Claude Code ─► tap/usage-shim.ts ─► proxy Anthropic
                 relais permanent 127.0.0.1:4748 ou port éphémère par session
                 répare `usage` des réponses /v1/messages via count_tokens du même proxy
```

## Couches du démon (`host/src/`)

| Dossier | Rôle |
|---------|------|
| `sources/` | Lecture pure des fichiers : `registry.ts` (registre Claude Code), `transcript.ts` (journal Claude Code), `statuslineSpool.ts`, `quota.ts`, `codexSessions.ts` (rollouts tenus ouverts, via `/proc`), `codexRollout.ts` (journal Codex). Socle commun : `jsonlTail.ts` (lecture incrémentale d'un `.jsonl` qui grandit) et `sessionStats.ts` (tokens, outils, courbe par minute, classification des outils des deux fournisseurs). |
| `domain/` | `collector.ts` collecte les deux fournisseurs en parallèle et produit un `DashboardState` ; `behavior.ts` (activité, humeur, seuils) ; `avatar.ts` (apparence déterministe par identifiant de session). |
| `transport/` | `httpServer.ts` (fichiers web, `/api/state`, `/events`), `serialBridge.ts` (détection de la carte, reconnexion, lecture non bloquante), `deviceFrame.ts` (trame série v2, clés courtes, < 4 000 octets). |
| `usageShim/` | `sse.ts`, `repair.ts`, `server.ts` : mandataire HTTP local qui ne réécrit que `usage`. |
| `types.ts`, `config.ts` | Contrats partagés (`SessionView`, `DashboardState`, `Provider`…), chemins, ports, délais. |

## Points d'entrée

- `host/src/main.ts` : tick d'une seconde (collecte → publication SSE → trame série), purge horaire du spool, arrêt propre.
- `tap/statusline-tap.sh` : branché dans `~/.claude/settings.json` (`statusLine.command`).
- `tap/usage-shim.ts` : correcteur d'usage, mode commande (`-- claude`) ou relais (`--serve`).
- `web/app.js` : grille des chambres et routage vers la vue détaillée (`web/detail.js`) ; `web/sprites.js` est le rendu de référence des sprites.
- `firmware/src/main.cpp` : boucle série, tactile, bouton BOOT ; `dashboard.cpp` grille et vue détaillée ; `scene.cpp` doit rester fidèle à `web/sprites.js`.

## Invariants

- Serveur HTTP sur `127.0.0.1` seulement, en-tête `Host` vérifié, CSP stricte, GET seul.
- Aucun secret lu : ni `~/.claude/sessions/*.key`, ni jeton OAuth, ni `~/.codex/auth.json`. Le quota Anthropic vient du JSON que Claude Code donne à sa barre d'état ; le quota OpenAI vient des `rate_limits` que Codex écrit dans son journal.
- Un message facturé sans aucun token d'entrée est la signature d'un proxy qui ne transmet pas `usage` : la session est marquée `usageReliable: false`, son contexte et son coût ne sont pas publiés.
- Chaque session reçoit l'humeur de son propre compte : `quotas.claude` et `quotas.codex` ne se mélangent jamais.
- `shared/sprites.json` est la source unique des sprites ; `pnpm sprites` régénère `firmware/include/sprites_gen.h`.
- Trame série : champs ajoutés toujours facultatifs côté carte ; un changement incompatible incrémente la version des deux côtés dans le même commit (voir [serial-protocol.md](serial-protocol.md)).

## Sessions Codex : ce qui est mesuré

Format observé le 2026-10-25 (Codex CLI 0.157/0.164, Codex Desktop 0.162/0.163). Une ligne `{timestamp, type, payload}` par événement :

| Type | Ce qu'on en tire |
|------|------------------|
| `session_meta` | identifiant, dossier, date de début, version, `source.subagent` (fil de sous-agent, non affiché) |
| `turn_context`, `thread_settings_applied` | modèle |
| `event_msg` `task_started` / `task_complete` / `turn_aborted` | tours ouverts → au travail ou au repos ; `*_approval_request`, `request_user_input*` → attend l'humain |
| `event_msg` `token_count` | `total_token_usage` cumulé (seul l'accroissement compte), `last_token_usage` (contexte = total − réflexion sur `model_context_window`), `rate_limits` rangées par durée (≤ 12 h → « 5 h », sinon « semaine ») |
| `response_item` | `function_call`, `custom_tool_call` (`exec`/`js` éclatés selon les `tools.<nom>(…)` appelés), `web_search_call`, `reasoning` |

Pièges : les identifiants sont des UUIDv7 (le préfixe est un horodatage, la trame série transmet les 8 derniers caractères) ; `cached_input_tokens` est inclus dans `input_tokens` ; le premier `token_count` d'une session a des composantes nulles ; un rollout de sous-agent recopie l'en-tête de son parent.
