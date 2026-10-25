#include "protocol.h"

#include <ArduinoJson.h>
#include <limits>
#include <string.h>

namespace mascots {

namespace {

// Entier tolérant : défaut si la valeur est absente ou n'est pas un entier, sinon ramené aux bornes de T.
// Les compteurs du PC (tokens, appels d'outil) peuvent dépasser le type du modèle : on sature, on ne tronque pas.
template <typename T>
T readInt(JsonVariantConst value, T fallback) {
  if (!value.is<int64_t>()) return fallback;
  const int64_t raw = value.as<int64_t>();
  const int64_t lowest = static_cast<int64_t>(std::numeric_limits<T>::lowest());
  const int64_t highest = static_cast<int64_t>(std::numeric_limits<T>::max());
  if (raw < lowest) return std::numeric_limits<T>::lowest();
  if (raw > highest) return std::numeric_limits<T>::max();
  return static_cast<T>(raw);
}

// nullptr si la valeur n'est pas une chaîne.
const char* textOf(JsonVariantConst value) { return value.is<const char*>() ? value.as<const char*>() : nullptr; }

char readCode(JsonVariantConst value, char fallback) {
  const char* text = textOf(value);
  return (text != nullptr && text[0] != '\0') ? text[0] : fallback;
}

// Copie tronquée et toujours terminée par '\0'. La coupure ne tombe jamais au milieu d'un caractère
// UTF-8 (la carte n'affiche que de l'ASCII, mais une séquence coupée ferait un octet invalide).
void copyText(char* dest, size_t capacity, const char* source) {
  size_t length = 0;
  while (length < capacity - 1 && source[length] != '\0') length += 1;
  if (source[length] != '\0') {
    while (length > 0 && (static_cast<uint8_t>(source[length]) & 0xC0) == 0x80) length -= 1;
  }
  memcpy(dest, source, length);
  dest[length] = '\0';
}

template <size_t N>
void copyText(char (&dest)[N], const char* source) {
  copyText(dest, N, source);
}

// Champ texte facultatif : absent ou mal typé, il garde la valeur par défaut (chaîne vide).
template <size_t N>
void readOptionalText(JsonVariantConst value, char (&dest)[N]) {
  const char* text = textOf(value);
  if (text != nullptr) copyText(dest, text);
}

// Tableau facultatif de nombres : trop court, le reste garde sa valeur par défaut (0) ; trop long, l'excédent est ignoré.
template <typename T, size_t N>
void readNumberArray(JsonVariantConst value, T (&dest)[N]) {
  const JsonArrayConst array = value.as<JsonArrayConst>();
  for (size_t index = 0; index < N && index < array.size(); index += 1) {
    dest[index] = readInt<T>(array[index], 0);
  }
}

// Quota facultatif (`q2`) : absent ou différent de 4 entiers, il vaut -1 partout et la trame reste valide.
AccountQuota readOptionalQuota(JsonVariantConst value) {
  AccountQuota quota;
  const JsonArrayConst array = value.as<JsonArrayConst>();
  if (array.size() != 4) return quota;
  for (JsonVariantConst entry : array) {
    if (!entry.is<int64_t>()) return AccountQuota{};
  }
  quota.fiveHour = {readInt<int16_t>(array[0], -1), readInt<int32_t>(array[1], -1)};
  quota.sevenDay = {readInt<int16_t>(array[2], -1), readInt<int32_t>(array[3], -1)};
  return quota;
}

// Fournisseur facultatif : "x" = Codex, toute autre valeur (ou absence) = Claude Code.
uint8_t readProvider(JsonVariantConst value) { return readCode(value, 'c') == 'x' ? PROVIDER_CODEX : PROVIDER_CLAUDE; }

// false si un champ obligatoire (id, n, a, m) manque : la trame entière est alors refusée.
// Le nom peut être vide (le démon retire les emojis), pas l'identifiant ni les codes d'état.
bool readSession(JsonObjectConst source, Session& session) {
  const char* id = textOf(source["id"]);
  const char* name = textOf(source["n"]);
  const char* activity = textOf(source["a"]);
  const char* mood = textOf(source["m"]);
  if (id == nullptr || id[0] == '\0' || name == nullptr) return false;
  if (activity == nullptr || activity[0] == '\0' || mood == nullptr || mood[0] == '\0') return false;

  session = Session{};
  copyText(session.id, id);
  copyText(session.name, name);
  session.activity = activity[0];
  session.mood = mood[0];

  // Index bruts : le rendu les borne aux listes réellement compilées (sprites_gen.h).
  session.hue = readInt<uint16_t>(source["h"], 0) % 360;
  session.skin = readInt<uint8_t>(source["sk"], 0);
  session.hair = readInt<uint8_t>(source["hc"], 0);
  session.hairStyle = readInt<uint8_t>(source["hs"], 0);
  session.provider = readProvider(source["pv"]);
  session.moodCause = readCode(source["mc"], '-');
  session.tool = readCode(source["k"], '-');
  readOptionalText(source["tn"], session.toolName);
  readOptionalText(source["md"], session.model);
  readOptionalText(source["p"], session.project);

  session.contextPercent = readInt<int16_t>(source["x"], -1);
  session.contextWindowK = readInt<int32_t>(source["cw"], -1);
  session.tokensPerMinute = readInt<int32_t>(source["r"], 0);
  session.costCents = readInt<int32_t>(source["c"], -1);
  session.turns = readInt<int32_t>(source["u"], 0);
  session.uptimeMinutes = readInt<int32_t>(source["up"], 0);
  session.idleSeconds = readInt<int32_t>(source["ld"], -1);
  session.tokensInput = readInt<int64_t>(source["ti"], 0);
  session.tokensOutput = readInt<int64_t>(source["to"], 0);
  session.tokensCacheRead = readInt<int64_t>(source["tr"], 0);
  session.tokensCacheWrite = readInt<int64_t>(source["tw"], 0);
  readNumberArray(source["tc"], session.toolCounts);
  readNumberArray(source["hh"], session.history);
  return true;
}

}  // namespace

ParseResult parseFrame(const char* line, size_t length, Frame& out) {
  JsonDocument document;
  if (deserializeJson(document, line, length) != DeserializationError::Ok) return ParseResult::InvalidJson;
  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (root.isNull()) return ParseResult::InvalidJson;

  // La version se juge avant le reste : une trame d'un autre protocole n'a pas à avoir nos champs.
  const JsonVariantConst version = root["v"];
  if (version.isNull()) return ParseResult::MissingFields;
  if (!version.is<int64_t>() || version.as<int64_t>() != PROTOCOL_VERSION) return ParseResult::WrongVersion;

  const JsonArrayConst quota = root["q"];
  const JsonObjectConst totals = root["tot"];
  const JsonArrayConst sessions = root["s"];
  if (!root["t"].is<int64_t>() || quota.isNull() || quota.size() != 4 || totals.isNull() || sessions.isNull()) {
    return ParseResult::MissingFields;
  }

  Frame frame;
  frame.timestamp = readInt<uint32_t>(root["t"], 0);

  const JsonArrayConst clock = root["lt"].as<JsonArrayConst>();
  if (clock.size() == 2) {
    const int32_t hour = readInt<int32_t>(clock[0], -1);
    const int32_t minute = readInt<int32_t>(clock[1], -1);
    if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
      frame.localHour = static_cast<int8_t>(hour);
      frame.localMinute = static_cast<int8_t>(minute);
    }
  }

  AccountQuota& claudeQuota = frame.quota[PROVIDER_CLAUDE];
  claudeQuota.fiveHour = {readInt<int16_t>(quota[0], -1), readInt<int32_t>(quota[1], -1)};
  claudeQuota.sevenDay = {readInt<int16_t>(quota[2], -1), readInt<int32_t>(quota[3], -1)};
  frame.quota[PROVIDER_CODEX] = readOptionalQuota(root["q2"]);
  frame.totalCostCents = readInt<int32_t>(totals["c"], 0);
  frame.totalTokensPerMinute = readInt<int32_t>(totals["r"], 0);
  frame.sessionCount = readInt<uint16_t>(totals["n"], 0);
  frame.workingCount = readInt<uint16_t>(totals["w"], 0);

  // Seules les sessions affichables sont lues (et donc validées) ; le démon n'en envoie pas davantage.
  for (JsonVariantConst entry : sessions) {
    if (frame.visibleCount >= MAX_SESSIONS) break;
    if (!entry.is<JsonObjectConst>()) return ParseResult::MissingFields;
    if (!readSession(entry.as<JsonObjectConst>(), frame.sessions[frame.visibleCount])) return ParseResult::MissingFields;
    frame.visibleCount += 1;
  }
  out = frame;
  return ParseResult::Ok;
}

const char* describe(ParseResult result) {
  switch (result) {
    case ParseResult::Ok:
      return "ok";
    case ParseResult::InvalidJson:
      return "json invalide";
    case ParseResult::WrongVersion:
      return "version de protocole inconnue";
    case ParseResult::MissingFields:
      return "champs manquants";
  }
  return "?";
}

}  // namespace mascots
