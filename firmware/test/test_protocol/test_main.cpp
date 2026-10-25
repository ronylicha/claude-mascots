// Tests du décodeur de trames v2, exécutés sur PC : pio test -e native
#include <limits.h>
#include <stdint.h>
#include <string.h>
#include <unity.h>

#include <string>

#include "protocol.h"

using namespace mascots;

namespace {

ParseResult parse(const char* line, Frame& frame) { return parseFrame(line, strlen(line), frame); }
ParseResult parse(const std::string& line, Frame& frame) { return parseFrame(line.c_str(), line.size(), frame); }

// Trame conforme à docs/serial-protocol.md et à host/src/transport/deviceFrame.ts.
const char* kHostFrame = R"json({"v":2,"t":1792805400,"lt":[22,15],"q":[42,90,1,1044],"q2":[-1,-1,29,1440],"tot":{"c":1235,"r":12608,"n":2,"w":1},"s":[)json"
                         R"json({"id":"0702150f","n":"projects-50","h":203,"sk":1,"hc":3,"hs":0,"pv":"c","a":"w","m":"f","mc":"-","k":"s","tn":"WebSearch",)json"
                         R"json("x":32,"cw":200,"r":10397,"c":307,"md":"Opus 5.5","p":"claude-mascots","u":184,"up":95,"ld":4,)json"
                         R"json("ti":1520,"to":88213,"tr":15022918,"tw":412877,"tc":[52,31,40,6,3,90,12],)json"
                         R"json("hh":[0,0,1200,8400,10397,9800,7200,0,0,0,3100,5400,6000,9100,10397]},)json"
                         R"json({"id":"a1b2c3d4","n":"rony-85","h":319,"sk":3,"hc":0,"hs":2,"pv":"x","a":"s","m":"w","mc":"q","k":"-","tn":"",)json"
                         R"json("x":-1,"cw":-1,"r":2211,"c":-1,"md":"","p":"rony","u":0,"up":3,"ld":-1,"ti":0,"to":0,"tr":0,"tw":0,)json"
                         R"json("tc":[0,0,0,0,0,0,0],"hh":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]}]})json";

// Une session aux valeurs maximales que le démon puisse produire (même contenu que le test de trame pire cas côté PC).
const char* kWorstSession =
    R"json({"id":"ffffffff","n":"WWWWWWWWWWWW","h":359,"sk":3,"hc":5,"hs":2,"pv":"x","a":"a","m":"x","mc":"w","k":"o","tn":"WWWWWWWWWWWWWWWW",)json"
    R"json("x":100,"cw":1000,"r":999999999999,"c":999999999,"md":"WWWWWWWWWWWWWWWW","p":"WWWWWWWWWWWWWWWW","u":9999999,"up":30030090,)json"
    R"json("ld":1801805400,"ti":9007199254740991,"to":9007199254740991,"tr":9007199254740991,"tw":9007199254740991,)json"
    R"json("tc":[99999,99999,99999,99999,99999,99999,99999],)json"
    R"json("hh":[999999999999,999999999999,999999999999,999999999999,999999999999,999999999999,999999999999,)json"
    R"json(999999999999,999999999999,999999999999,999999999999,999999999999,999999999999,999999999999,999999999999]})json";

// Enveloppe minimale valide autour d'une liste de sessions déjà sérialisée.
std::string frameAround(const std::string& sessions) {
  return std::string(R"json({"v":2,"t":1,"q":[0,0,0,0],"tot":{},"s":[)json") + sessions + "]}";
}

void expectUnknownQuota(const AccountQuota& quota) {
  TEST_ASSERT_EQUAL_INT16(-1, quota.fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(-1, quota.fiveHour.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(-1, quota.sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(-1, quota.sevenDay.resetMinutes);
}

// Enveloppe valide avec un fragment JSON libre juste après `q` (par exemple `"q2":[1,2,3],`).
std::string frameWithExtra(const std::string& extra) {
  return std::string(R"json({"v":2,"t":1,"q":[10,20,30,40],)json") + extra + R"json("tot":{},"s":[]})json";
}

const char* kMinimalSession = R"json({"id":"abcd1234","n":"x","a":"i","m":"h"})json";

}  // namespace

void setUp() {}
void tearDown() {}

void test_decodes_host_frame() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(kHostFrame, frame));

  TEST_ASSERT_EQUAL_UINT32(1792805400u, frame.timestamp);
  TEST_ASSERT_EQUAL_INT8(22, frame.localHour);
  TEST_ASSERT_EQUAL_INT8(15, frame.localMinute);
  TEST_ASSERT_EQUAL_INT16(42, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(90, frame.quota[PROVIDER_CLAUDE].fiveHour.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(1, frame.quota[PROVIDER_CLAUDE].sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(1044, frame.quota[PROVIDER_CLAUDE].sevenDay.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(-1, frame.quota[PROVIDER_CODEX].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(-1, frame.quota[PROVIDER_CODEX].fiveHour.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(29, frame.quota[PROVIDER_CODEX].sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(1440, frame.quota[PROVIDER_CODEX].sevenDay.resetMinutes);
  TEST_ASSERT_EQUAL_INT32(1235, frame.totalCostCents);
  TEST_ASSERT_EQUAL_INT32(12608, frame.totalTokensPerMinute);
  TEST_ASSERT_EQUAL_UINT16(2, frame.sessionCount);
  TEST_ASSERT_EQUAL_UINT16(1, frame.workingCount);
  TEST_ASSERT_EQUAL_UINT8(2, frame.visibleCount);

  const Session& first = frame.sessions[0];
  TEST_ASSERT_EQUAL_STRING("0702150f", first.id);
  TEST_ASSERT_EQUAL_STRING("projects-50", first.name);
  TEST_ASSERT_EQUAL_UINT16(203, first.hue);
  TEST_ASSERT_EQUAL_UINT8(1, first.skin);
  TEST_ASSERT_EQUAL_UINT8(3, first.hair);
  TEST_ASSERT_EQUAL_UINT8(0, first.hairStyle);
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CLAUDE, first.provider);
  TEST_ASSERT_EQUAL_CHAR('w', first.activity);
  TEST_ASSERT_EQUAL_CHAR('f', first.mood);
  TEST_ASSERT_EQUAL_CHAR('-', first.moodCause);
  TEST_ASSERT_EQUAL_CHAR('s', first.tool);
  TEST_ASSERT_EQUAL_STRING("WebSearch", first.toolName);
  TEST_ASSERT_EQUAL_INT16(32, first.contextPercent);
  TEST_ASSERT_EQUAL_INT32(200, first.contextWindowK);
  TEST_ASSERT_EQUAL_INT32(10397, first.tokensPerMinute);
  TEST_ASSERT_EQUAL_INT32(307, first.costCents);
  TEST_ASSERT_EQUAL_STRING("Opus 5.5", first.model);
  TEST_ASSERT_EQUAL_STRING("claude-mascots", first.project);
  TEST_ASSERT_EQUAL_INT32(184, first.turns);
  TEST_ASSERT_EQUAL_INT32(95, first.uptimeMinutes);
  TEST_ASSERT_EQUAL_INT32(4, first.idleSeconds);
  TEST_ASSERT_EQUAL_INT64(1520, first.tokensInput);
  TEST_ASSERT_EQUAL_INT64(88213, first.tokensOutput);
  TEST_ASSERT_EQUAL_INT64(15022918, first.tokensCacheRead);
  TEST_ASSERT_EQUAL_INT64(412877, first.tokensCacheWrite);
  const uint16_t expectedCounts[TOOL_KIND_COUNT] = {52, 31, 40, 6, 3, 90, 12};
  TEST_ASSERT_EQUAL_UINT16_ARRAY(expectedCounts, first.toolCounts, TOOL_KIND_COUNT);
  const int32_t expectedHistory[HISTORY_POINTS] = {0, 0, 1200, 8400, 10397, 9800, 7200, 0, 0, 0, 3100, 5400, 6000, 9100, 10397};
  TEST_ASSERT_EQUAL_INT32_ARRAY(expectedHistory, first.history, HISTORY_POINTS);

  const Session& second = frame.sessions[1];
  TEST_ASSERT_EQUAL_STRING("a1b2c3d4", second.id);
  TEST_ASSERT_EQUAL_UINT16(319, second.hue);
  TEST_ASSERT_EQUAL_UINT8(2, second.hairStyle);
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CODEX, second.provider);
  TEST_ASSERT_EQUAL_CHAR('s', second.activity);
  TEST_ASSERT_EQUAL_CHAR('w', second.mood);
  TEST_ASSERT_EQUAL_CHAR('q', second.moodCause);
  TEST_ASSERT_EQUAL_CHAR('-', second.tool);
  TEST_ASSERT_EQUAL_STRING("", second.toolName);
  TEST_ASSERT_EQUAL_INT16(-1, second.contextPercent);
  TEST_ASSERT_EQUAL_INT32(-1, second.contextWindowK);
  TEST_ASSERT_EQUAL_INT32(-1, second.costCents);
  TEST_ASSERT_EQUAL_INT32(-1, second.idleSeconds);
}

void test_decodes_token_counters_beyond_32_bits() {
  const std::string line = frameAround(
      R"json({"id":"abcd1234","n":"x","a":"i","m":"h","ti":4294967296,"to":9007199254740991,"tr":15022918000,"tw":2147483648})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_TRUE(frame.sessions[0].tokensInput == 4294967296LL);
  TEST_ASSERT_TRUE(frame.sessions[0].tokensOutput == 9007199254740991LL);
  TEST_ASSERT_TRUE(frame.sessions[0].tokensCacheRead == 15022918000LL);
  TEST_ASSERT_TRUE(frame.sessions[0].tokensCacheWrite == 2147483648LL);
}

void test_gives_optional_fields_their_model_defaults() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(frameAround(kMinimalSession), frame));
  TEST_ASSERT_EQUAL_INT8(-1, frame.localHour);
  TEST_ASSERT_EQUAL_INT8(-1, frame.localMinute);
  TEST_ASSERT_EQUAL_UINT8(1, frame.visibleCount);
  // `q` est obligatoire (ici à zéro) ; seul `q2`, absent, retombe sur « inconnu ».
  expectUnknownQuota(frame.quota[PROVIDER_CODEX]);
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CLAUDE, frame.sessions[0].provider);

  const Session& session = frame.sessions[0];
  TEST_ASSERT_EQUAL_STRING("abcd1234", session.id);
  TEST_ASSERT_EQUAL_STRING("x", session.name);
  TEST_ASSERT_EQUAL_CHAR('i', session.activity);
  TEST_ASSERT_EQUAL_CHAR('h', session.mood);
  TEST_ASSERT_EQUAL_UINT16(0, session.hue);
  TEST_ASSERT_EQUAL_UINT8(0, session.skin);
  TEST_ASSERT_EQUAL_UINT8(0, session.hair);
  TEST_ASSERT_EQUAL_UINT8(0, session.hairStyle);
  TEST_ASSERT_EQUAL_CHAR('-', session.moodCause);
  TEST_ASSERT_EQUAL_CHAR('-', session.tool);
  TEST_ASSERT_EQUAL_STRING("", session.toolName);
  TEST_ASSERT_EQUAL_STRING("", session.model);
  TEST_ASSERT_EQUAL_STRING("", session.project);
  TEST_ASSERT_EQUAL_INT16(-1, session.contextPercent);
  TEST_ASSERT_EQUAL_INT32(-1, session.contextWindowK);
  TEST_ASSERT_EQUAL_INT32(0, session.tokensPerMinute);
  TEST_ASSERT_EQUAL_INT32(-1, session.costCents);
  TEST_ASSERT_EQUAL_INT32(0, session.turns);
  TEST_ASSERT_EQUAL_INT32(0, session.uptimeMinutes);
  TEST_ASSERT_EQUAL_INT32(-1, session.idleSeconds);
  TEST_ASSERT_TRUE(session.tokensInput == 0 && session.tokensCacheWrite == 0);
  for (uint8_t index = 0; index < TOOL_KIND_COUNT; index += 1) TEST_ASSERT_EQUAL_UINT16(0, session.toolCounts[index]);
  for (uint8_t index = 0; index < HISTORY_POINTS; index += 1) TEST_ASSERT_EQUAL_INT32(0, session.history[index]);
}

void test_tolerates_short_and_long_tool_count_and_history_arrays() {
  const std::string shortArrays = frameAround(R"json({"id":"abcd1234","n":"x","a":"i","m":"h","tc":[1,2,3],"hh":[5,6]})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(shortArrays, frame));
  const uint16_t expectedCounts[TOOL_KIND_COUNT] = {1, 2, 3, 0, 0, 0, 0};
  TEST_ASSERT_EQUAL_UINT16_ARRAY(expectedCounts, frame.sessions[0].toolCounts, TOOL_KIND_COUNT);
  TEST_ASSERT_EQUAL_INT32(5, frame.sessions[0].history[0]);
  TEST_ASSERT_EQUAL_INT32(6, frame.sessions[0].history[1]);
  TEST_ASSERT_EQUAL_INT32(0, frame.sessions[0].history[2]);

  const std::string emptyArrays = frameAround(R"json({"id":"abcd1234","n":"x","a":"i","m":"h","tc":[],"hh":[]})json");
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(emptyArrays, frame));
  TEST_ASSERT_EQUAL_UINT16(0, frame.sessions[0].toolCounts[0]);

  // Trop longs : l'excédent est ignoré sans déborder sur les champs voisins.
  const std::string longArrays = frameAround(
      R"json({"id":"abcd1234","n":"x","a":"i","m":"h","x":55,"tc":[1,2,3,4,5,6,7,8,9],"hh":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]})json");
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(longArrays, frame));
  TEST_ASSERT_EQUAL_UINT16(7, frame.sessions[0].toolCounts[6]);
  TEST_ASSERT_EQUAL_INT32(15, frame.sessions[0].history[HISTORY_POINTS - 1]);
  TEST_ASSERT_EQUAL_INT16(55, frame.sessions[0].contextPercent);

  // Un `tc` qui n'est pas un tableau est traité comme absent.
  const std::string wrongType = frameAround(R"json({"id":"abcd1234","n":"x","a":"i","m":"h","tc":5,"hh":"abc"})json");
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(wrongType, frame));
  TEST_ASSERT_EQUAL_UINT16(0, frame.sessions[0].toolCounts[0]);
}

void test_saturates_values_that_do_not_fit_the_model() {
  const std::string line = std::string(R"json({"v":2,"t":99999999999,"q":[100000,5000000000,-70000,-1],"tot":{"c":9999999999,"r":-9999999999,"n":70000,"w":-3},"s":[)json") +
                           R"json({"id":"abcd1234","n":"x","a":"i","m":"h","h":725,"sk":300,"x":100000,"c":9999999999,"tc":[70000,-5,65535,65536],"hh":[999999999999,-999999999999]}]})json";
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, frame.timestamp);
  TEST_ASSERT_EQUAL_INT16(INT16_MAX, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(INT32_MAX, frame.quota[PROVIDER_CLAUDE].fiveHour.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(INT16_MIN, frame.quota[PROVIDER_CLAUDE].sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(-1, frame.quota[PROVIDER_CLAUDE].sevenDay.resetMinutes);
  TEST_ASSERT_EQUAL_INT32(INT32_MAX, frame.totalCostCents);
  TEST_ASSERT_EQUAL_INT32(INT32_MIN, frame.totalTokensPerMinute);
  TEST_ASSERT_EQUAL_UINT16(UINT16_MAX, frame.sessionCount);
  TEST_ASSERT_EQUAL_UINT16(0, frame.workingCount);

  const Session& session = frame.sessions[0];
  TEST_ASSERT_EQUAL_UINT16(725 % 360, session.hue);
  TEST_ASSERT_EQUAL_UINT8(UINT8_MAX, session.skin);
  TEST_ASSERT_EQUAL_INT16(INT16_MAX, session.contextPercent);
  TEST_ASSERT_EQUAL_INT32(INT32_MAX, session.costCents);
  TEST_ASSERT_EQUAL_UINT16(UINT16_MAX, session.toolCounts[0]);
  TEST_ASSERT_EQUAL_UINT16(0, session.toolCounts[1]);
  TEST_ASSERT_EQUAL_UINT16(65535, session.toolCounts[2]);
  TEST_ASSERT_EQUAL_UINT16(UINT16_MAX, session.toolCounts[3]);
  TEST_ASSERT_EQUAL_INT32(INT32_MAX, session.history[0]);
  TEST_ASSERT_EQUAL_INT32(INT32_MIN, session.history[1]);
}

void test_truncates_long_strings_to_their_capacity() {
  const std::string line = frameAround(
      R"json({"id":"0123456789abcdef","n":"un-nom-beaucoup-trop-long","a":"i","m":"h",)json"
      R"json("tn":"un-outil-au-nom-vraiment-trop-long","md":"un-modele-au-nom-vraiment-trop-long","p":"un-dossier-au-nom-vraiment-trop-long"})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_STRING("01234567", frame.sessions[0].id);
  TEST_ASSERT_EQUAL_STRING("un-nom-beauc", frame.sessions[0].name);
  TEST_ASSERT_EQUAL_STRING("un-outil-au-nom-", frame.sessions[0].toolName);
  TEST_ASSERT_EQUAL_STRING("un-modele-au-nom", frame.sessions[0].model);
  TEST_ASSERT_EQUAL_STRING("un-dossier-au-no", frame.sessions[0].project);
}

void test_never_cuts_a_utf8_character_in_two() {
  // 11 « a » puis « é » (2 octets) : la 12e position tomberait au milieu du é, on recule d'un octet.
  const std::string line = frameAround(R"json({"id":"abcd1234","n":"aaaaaaaaaaaéz","a":"i","m":"h"})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_STRING("aaaaaaaaaaa", frame.sessions[0].name);

  // Si le caractère tient exactement, il est conservé.
  const std::string fits = frameAround(R"json({"id":"abcd1234","n":"aaaaaaaaaaéz","a":"i","m":"h"})json");
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(fits, frame));
  TEST_ASSERT_EQUAL_STRING("aaaaaaaaaa\xC3\xA9", frame.sessions[0].name);
}

void test_accepts_an_empty_name_but_not_an_empty_state_code() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(frameAround(R"json({"id":"abcd1234","n":"","a":"i","m":"h"})json"), frame));
  TEST_ASSERT_EQUAL_STRING("", frame.sessions[0].name);
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(frameAround(R"json({"id":"abcd1234","n":"x","a":"","m":"h"})json"), frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(frameAround(R"json({"id":"","n":"x","a":"i","m":"h"})json"), frame));
}

void test_ignores_unknown_fields() {
  const std::string line = frameAround(R"json({"id":"abcd1234","n":"x","a":"i","m":"h","futur":{"a":[1,2]},"x":12})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_INT16(12, frame.sessions[0].contextPercent);
}

void test_rejects_an_out_of_range_clock_without_failing_the_frame() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok,
                    parse(R"json({"v":2,"t":1,"lt":[25,61],"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL_INT8(-1, frame.localHour);
  TEST_ASSERT_EQUAL_INT8(-1, frame.localMinute);
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(R"json({"v":2,"t":1,"lt":[7],"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL_INT8(-1, frame.localHour);
}

void test_rejects_garbage_without_touching_previous_frame() {
  Frame frame;
  parse(kHostFrame, frame);
  TEST_ASSERT_EQUAL(ParseResult::InvalidJson, parse("{\"v\":2,\"q\":[", frame));
  TEST_ASSERT_EQUAL(ParseResult::InvalidJson, parse("", frame));
  TEST_ASSERT_EQUAL(ParseResult::InvalidJson, parse("[1,2,3]", frame));
  TEST_ASSERT_EQUAL(ParseResult::InvalidJson, parse("42", frame));
  TEST_ASSERT_EQUAL_UINT8(2, frame.visibleCount);
  TEST_ASSERT_EQUAL_STRING("projects-50", frame.sessions[0].name);
}

void test_keeps_previous_frame_when_a_session_is_incomplete() {
  Frame frame;
  parse(kHostFrame, frame);
  const std::string line = frameAround(std::string(kMinimalSession) + R"json(,{"id":"abcd1234","n":"x","m":"h"})json");
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(line, frame));
  TEST_ASSERT_EQUAL_UINT8(2, frame.visibleCount);
  TEST_ASSERT_EQUAL_STRING("projects-50", frame.sessions[0].name);
}

void test_rejects_unknown_protocol_version() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::WrongVersion, parse(R"json({"v":3,"t":1,"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
  // Une trame v1 (espèces animales) n'est pas décodée en v2.
  TEST_ASSERT_EQUAL(ParseResult::WrongVersion, parse(R"json({"v":1,"q":[0,0,0,0],"tot":{},"s":[{"n":"x","sp":4}]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::WrongVersion, parse(R"json({"v":"2","t":1,"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
}

void test_rejects_missing_top_level_fields() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"t":1,"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"q":[0,0,0,0],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":1,"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":1,"q":[1,2],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":1,"q":[0,0,0,0,0],"tot":{},"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":1,"q":[0,0,0,0],"s":[]})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":1,"q":[0,0,0,0],"tot":{}})json", frame));
  TEST_ASSERT_EQUAL(ParseResult::MissingFields, parse(R"json({"v":2,"t":"1","q":[0,0,0,0],"tot":{},"s":[]})json", frame));
}

void test_rejects_a_session_missing_a_mandatory_field() {
  Frame frame;
  const char* incomplete[] = {
      R"json({"n":"x","a":"i","m":"h"})json",
      R"json({"id":"abcd1234","a":"i","m":"h"})json",
      R"json({"id":"abcd1234","n":"x","m":"h"})json",
      R"json({"id":"abcd1234","n":"x","a":"i"})json",
      R"json({"id":12345678,"n":"x","a":"i","m":"h"})json",
      R"json("pas un objet")json",
      R"json({})json",
  };
  for (const char* session : incomplete) {
    TEST_ASSERT_EQUAL_MESSAGE(ParseResult::MissingFields, parse(frameAround(session), frame), session);
  }
}

void test_accepts_a_frame_without_sessions() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(R"json({"v":2,"t":5,"q":[-1,-1,-1,-1],"tot":{"n":0,"w":0},"s":[]})json", frame));
  TEST_ASSERT_EQUAL_UINT8(0, frame.visibleCount);
  TEST_ASSERT_EQUAL_INT16(-1, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(-1, frame.quota[PROVIDER_CLAUDE].sevenDay.resetMinutes);
  expectUnknownQuota(frame.quota[PROVIDER_CODEX]);
}

void test_defaults_the_codex_quota_when_q2_is_absent() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(frameWithExtra(""), frame));
  TEST_ASSERT_EQUAL_INT16(10, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(40, frame.quota[PROVIDER_CLAUDE].sevenDay.resetMinutes);
  expectUnknownQuota(frame.quota[PROVIDER_CODEX]);
}

void test_reads_a_well_formed_q2() {
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(frameWithExtra(R"json("q2":[55,120,7,9000],)json"), frame));
  TEST_ASSERT_EQUAL_INT16(55, frame.quota[PROVIDER_CODEX].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT32(120, frame.quota[PROVIDER_CODEX].fiveHour.resetMinutes);
  TEST_ASSERT_EQUAL_INT16(7, frame.quota[PROVIDER_CODEX].sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(9000, frame.quota[PROVIDER_CODEX].sevenDay.resetMinutes);
  // Le quota Claude Code n'est pas touché par q2.
  TEST_ASSERT_EQUAL_INT16(10, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
}

void test_accepts_a_frame_with_a_malformed_q2() {
  const char* malformed[] = {
      R"json("q2":[1,2,3],)json",          // trop court
      R"json("q2":[1,2,3,4,5],)json",      // trop long
      R"json("q2":"x",)json",              // pas un tableau
      R"json("q2":[1,"2",3,4],)json",      // élément qui n'est pas un entier
      R"json("q2":null,)json",
      R"json("q2":{},)json",
  };
  for (const char* extra : malformed) {
    Frame frame;
    TEST_ASSERT_EQUAL_MESSAGE(ParseResult::Ok, parse(frameWithExtra(extra), frame), extra);
    expectUnknownQuota(frame.quota[PROVIDER_CODEX]);
    TEST_ASSERT_EQUAL_INT16_MESSAGE(10, frame.quota[PROVIDER_CLAUDE].fiveHour.percent, extra);
  }
}

void test_defaults_the_provider_to_claude_unless_pv_is_x() {
  Frame frame;
  const std::string absent = frameAround(kMinimalSession);
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(absent, frame));
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CLAUDE, frame.sessions[0].provider);

  const char* claude[] = {R"json("pv":"c")json", R"json("pv":"z")json", R"json("pv":"")json", R"json("pv":7)json", R"json("pv":"X")json"};
  for (const char* pv : claude) {
    const std::string line = frameAround(std::string(R"json({"id":"abcd1234","n":"x","a":"i","m":"h",)json") + pv + "}");
    TEST_ASSERT_EQUAL_MESSAGE(ParseResult::Ok, parse(line, frame), pv);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(PROVIDER_CLAUDE, frame.sessions[0].provider, pv);
  }

  const std::string codex = frameAround(R"json({"id":"abcd1234","n":"x","a":"i","m":"h","pv":"x"})json");
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(codex, frame));
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CODEX, frame.sessions[0].provider);
}

void test_keeps_the_provider_of_each_session() {
  const std::string line = frameAround(std::string(R"json({"id":"11111111","n":"a","a":"i","m":"h","pv":"x"},)json") +
                                       R"json({"id":"22222222","n":"b","a":"i","m":"h"},)json" +
                                       R"json({"id":"33333333","n":"c","a":"i","m":"h","pv":"c"})json");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CODEX, frame.sessions[0].provider);
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CLAUDE, frame.sessions[1].provider);
  TEST_ASSERT_EQUAL_UINT8(PROVIDER_CLAUDE, frame.sessions[2].provider);
}

void test_caps_sessions_at_six() {
  std::string sessions;
  for (int index = 0; index < 8; index += 1) {
    if (index > 0) sessions += ",";
    sessions += kMinimalSession;
  }
  std::string line = frameAround(sessions);
  // `tot.n` annonce 8 sessions côté PC même si l'écran n'en montre que 6.
  line.replace(line.find("\"tot\":{}"), 8, "\"tot\":{\"n\":8}");
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_UINT8(MAX_SESSIONS, frame.visibleCount);
  TEST_ASSERT_EQUAL_UINT16(8, frame.sessionCount);
}

void test_ignores_sessions_beyond_the_sixth_even_if_incomplete() {
  std::string sessions;
  for (int index = 0; index < MAX_SESSIONS; index += 1) sessions += std::string(kMinimalSession) + ",";
  sessions += "{},{}";
  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(frameAround(sessions), frame));
  TEST_ASSERT_EQUAL_UINT8(MAX_SESSIONS, frame.visibleCount);
}

void test_decodes_a_worst_case_frame_close_to_4000_bytes() {
  std::string line = R"json({"v":2,"t":1801805400,"lt":[6,30],"q":[100,0,100,0],"q2":[100,300,100,10080],"tot":{"c":9999999999,"r":999999999999,"n":99,"w":99},"s":[)json";
  for (int index = 0; index < MAX_SESSIONS; index += 1) {
    if (index > 0) line += ",";
    line += kWorstSession;
  }
  line += "]}";
  // Même ordre de grandeur que la trame pire cas du démon, sous la limite de 4 095 octets de la carte.
  TEST_ASSERT_GREATER_THAN_UINT32(3500, static_cast<uint32_t>(line.size()));
  TEST_ASSERT_LESS_THAN_UINT32(4096, static_cast<uint32_t>(line.size()));

  Frame frame;
  TEST_ASSERT_EQUAL(ParseResult::Ok, parse(line, frame));
  TEST_ASSERT_EQUAL_UINT8(MAX_SESSIONS, frame.visibleCount);
  TEST_ASSERT_EQUAL_UINT16(99, frame.sessionCount);
  TEST_ASSERT_EQUAL_INT16(100, frame.quota[PROVIDER_CLAUDE].fiveHour.percent);
  TEST_ASSERT_EQUAL_INT16(100, frame.quota[PROVIDER_CODEX].sevenDay.percent);
  TEST_ASSERT_EQUAL_INT32(INT32_MAX, frame.totalCostCents);
  for (uint8_t index = 0; index < MAX_SESSIONS; index += 1) {
    const Session& session = frame.sessions[index];
    TEST_ASSERT_EQUAL_STRING("ffffffff", session.id);
    TEST_ASSERT_EQUAL_UINT8(PROVIDER_CODEX, session.provider);
    TEST_ASSERT_EQUAL_STRING("WWWWWWWWWWWW", session.name);
    TEST_ASSERT_EQUAL_STRING("WWWWWWWWWWWWWWWW", session.toolName);
    TEST_ASSERT_EQUAL_STRING("WWWWWWWWWWWWWWWW", session.model);
    TEST_ASSERT_EQUAL_STRING("WWWWWWWWWWWWWWWW", session.project);
    TEST_ASSERT_EQUAL_UINT16(359, session.hue);
    TEST_ASSERT_EQUAL_CHAR('x', session.mood);
    TEST_ASSERT_EQUAL_CHAR('w', session.moodCause);
    TEST_ASSERT_EQUAL_INT16(100, session.contextPercent);
    TEST_ASSERT_EQUAL_INT32(1000, session.contextWindowK);
    TEST_ASSERT_EQUAL_INT32(1801805400, session.idleSeconds);
    TEST_ASSERT_TRUE(session.tokensInput == 9007199254740991LL);
    TEST_ASSERT_TRUE(session.tokensCacheRead == 9007199254740991LL);
    TEST_ASSERT_EQUAL_UINT16(UINT16_MAX, session.toolCounts[0]);
    TEST_ASSERT_EQUAL_INT32(INT32_MAX, session.history[HISTORY_POINTS - 1]);
  }
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_decodes_host_frame);
  RUN_TEST(test_decodes_token_counters_beyond_32_bits);
  RUN_TEST(test_gives_optional_fields_their_model_defaults);
  RUN_TEST(test_tolerates_short_and_long_tool_count_and_history_arrays);
  RUN_TEST(test_saturates_values_that_do_not_fit_the_model);
  RUN_TEST(test_truncates_long_strings_to_their_capacity);
  RUN_TEST(test_never_cuts_a_utf8_character_in_two);
  RUN_TEST(test_accepts_an_empty_name_but_not_an_empty_state_code);
  RUN_TEST(test_ignores_unknown_fields);
  RUN_TEST(test_rejects_an_out_of_range_clock_without_failing_the_frame);
  RUN_TEST(test_rejects_garbage_without_touching_previous_frame);
  RUN_TEST(test_keeps_previous_frame_when_a_session_is_incomplete);
  RUN_TEST(test_rejects_unknown_protocol_version);
  RUN_TEST(test_rejects_missing_top_level_fields);
  RUN_TEST(test_rejects_a_session_missing_a_mandatory_field);
  RUN_TEST(test_accepts_a_frame_without_sessions);
  RUN_TEST(test_defaults_the_codex_quota_when_q2_is_absent);
  RUN_TEST(test_reads_a_well_formed_q2);
  RUN_TEST(test_accepts_a_frame_with_a_malformed_q2);
  RUN_TEST(test_defaults_the_provider_to_claude_unless_pv_is_x);
  RUN_TEST(test_keeps_the_provider_of_each_session);
  RUN_TEST(test_caps_sessions_at_six);
  RUN_TEST(test_ignores_sessions_beyond_the_sixth_even_if_incomplete);
  RUN_TEST(test_decodes_a_worst_case_frame_close_to_4000_bytes);
  return UNITY_END();
}
