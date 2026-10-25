#pragma once
// Décodage d'une ligne JSON du protocole v2 (docs/serial-protocol.md).
// Aucune dépendance Arduino : testé sur PC (pio test -e native).
#include <stddef.h>

#include "model.h"

namespace mascots {

enum class ParseResult {
  Ok,
  InvalidJson,    // JSON mal formé, ou racine qui n'est pas un objet
  WrongVersion,   // `v` présent mais différent de PROTOCOL_VERSION
  MissingFields,  // champ obligatoire absent ou de mauvais type
};

// Décode `line` dans `out`. `out` n'est modifié qu'en cas de succès : après une trame rejetée,
// l'écran continue d'afficher la précédente.
//
// Obligatoires : `v`, `t`, `q` (4 entiers, quota Claude Code), `tot`, `s` ; par session `id`, `n`, `a`, `m`.
// Tout le reste prend la valeur par défaut de model.h s'il est absent. C'est le cas de `q2` (quota Codex :
// absent ou différent de 4 entiers, ses 4 valeurs valent -1 sans rejeter la trame) et de `pv` par session
// ("x" = Codex, absent ou autre valeur = Claude Code). Les tableaux `tc` et `hh`
// sont tolérés trop courts (le reste vaut 0). Au-delà de MAX_SESSIONS, les sessions sont ignorées.
// Les chaînes trop longues sont tronquées sans couper un caractère UTF-8 ; les entiers hors plage
// sont ramenés à la borne du type du modèle.
ParseResult parseFrame(const char* line, size_t length, Frame& out);

const char* describe(ParseResult result);

}  // namespace mascots
