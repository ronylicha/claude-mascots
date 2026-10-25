#pragma once
// Modèle des données reçues du PC (protocole série v2, voir docs/serial-protocol.md).
#include <stdint.h>

namespace mascots {

constexpr uint8_t PROTOCOL_VERSION = 2;
constexpr uint8_t MAX_SESSIONS = 6;
constexpr uint8_t ID_CAPACITY = 9;     // 8 caractères + '\0'
constexpr uint8_t NAME_CAPACITY = 13;  // 12 caractères + '\0'
constexpr uint8_t LABEL_CAPACITY = 17; // 16 caractères + '\0' (modèle, projet, outil)
constexpr uint8_t TOOL_KIND_COUNT = 7; // ordre : lecture, écriture, commande, recherche, délégation, réflexion, autre
constexpr uint8_t HISTORY_POINTS = 15; // tokens/min moyennés par tranches de 2 minutes, du plus ancien au plus récent

// Fournisseur d'une session : détermine le libellé affiché et le quota de référence.
enum Provider : uint8_t { PROVIDER_CLAUDE = 0, PROVIDER_CODEX = 1 };
constexpr uint8_t PROVIDER_COUNT = 2;

struct QuotaWindow {
  int16_t percent = -1;       // -1 = inconnu
  int32_t resetMinutes = -1;  // -1 = inconnu
};

// Quota d'un compte (Anthropic ou OpenAI) : fenêtre de 5 heures et fenêtre de 7 jours.
struct AccountQuota {
  QuotaWindow fiveHour;
  QuotaWindow sevenDay;
};

struct Session {
  char id[ID_CAPACITY] = {0};  // 8 derniers caractères de l'identifiant côté PC : suit une session d'une trame à l'autre
  char name[NAME_CAPACITY] = {0};
  uint8_t provider = PROVIDER_CLAUDE;  // PROVIDER_CLAUDE ou PROVIDER_CODEX
  uint16_t hue = 0;           // teinte du t-shirt et de la couverture
  uint8_t skin = 0;           // index dans sprites::SKIN_TONES
  uint8_t hair = 0;           // index dans sprites::HAIR_COLORS
  uint8_t hairStyle = 0;      // index dans sprites::HEADS_FRONT / HEADS_BACK
  char activity = 'i';        // w=travaille a=attend i=repos s=dort
  char mood = 'h';            // h=content f=concentré t=fatigué w=inquiet x=épuisé
  char moodCause = '-';       // q=quota 5 h, w=quota semaine, x=contexte, '-'=aucune
  char tool = '-';            // r e b s d t o, '-' = aucun
  char toolName[LABEL_CAPACITY] = {0};
  char model[LABEL_CAPACITY] = {0};
  char project[LABEL_CAPACITY] = {0};
  int16_t contextPercent = -1;
  int32_t contextWindowK = -1;  // taille de la fenêtre en milliers de tokens, -1 = inconnue
  int32_t tokensPerMinute = 0;
  int32_t costCents = -1;
  int32_t turns = 0;
  int32_t uptimeMinutes = 0;
  int32_t idleSeconds = -1;   // secondes depuis la dernière activité, -1 = inconnu
  int64_t tokensInput = 0;
  int64_t tokensOutput = 0;
  int64_t tokensCacheRead = 0;
  int64_t tokensCacheWrite = 0;
  uint16_t toolCounts[TOOL_KIND_COUNT] = {0};
  int32_t history[HISTORY_POINTS] = {0};
};

struct Frame {
  uint32_t timestamp = 0;
  int8_t localHour = -1;      // heure locale du PC (0-23), -1 = inconnue
  int8_t localMinute = -1;
  AccountQuota quota[PROVIDER_COUNT];  // indexé par Provider
  int32_t totalCostCents = 0;
  int32_t totalTokensPerMinute = 0;
  uint16_t sessionCount = 0;  // total côté PC (peut dépasser MAX_SESSIONS)
  uint16_t workingCount = 0;
  uint8_t visibleCount = 0;
  Session sessions[MAX_SESSIONS];
};

}  // namespace mascots
