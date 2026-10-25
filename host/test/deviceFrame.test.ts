import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MOOD_THRESHOLDS } from "../src/domain/behavior.ts";
import {
  ACTIVITY_CODE,
  buildDeviceFrame,
  compactHistory,
  encodeDeviceFrame,
  HISTORY_POINTS,
  MOOD_CAUSE_CODE,
  MOOD_CODE,
  PROTOCOL_VERSION,
  PROVIDER_CODE,
  TOOL_CODE,
  toAsciiLabel,
} from "../src/transport/deviceFrame.ts";
import { emptyToolCounts } from "../src/sources/transcript.ts";
import { noQuota } from "../src/sources/quota.ts";
import { TOOL_KINDS, type DashboardState, type SessionView } from "../src/types.ts";

const NOW = Date.parse("2026-10-24T03:30:00Z");
/** Taille maximale d'une trame promise par docs/serial-protocol.md (la carte accepte 4 095 octets). */
const FRAME_BUDGET = 4000;

function session(index: number, activity: SessionView["activity"], overrides: Partial<SessionView> = {}): SessionView {
  return {
    provider: "claude",
    sessionId: `0702150${index}-d8d9-4dc0-83a3-bd0c789053c5`,
    pid: 1000 + index,
    name: `très-long-nom-de-session-${index}-🦉`,
    project: "projects",
    cwd: "/home/rony/projects",
    version: "2.1.310",
    model: "Opus 5.5",
    status: activity === "working" ? "busy" : "idle",
    activity,
    mood: "focused",
    moodCause: null,
    tool: activity === "working" ? "write" : null,
    toolName: null,
    costUsd: 3.07,
    contextPercent: 32.4,
    contextWindowSize: 200_000,
    tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
    usageReliable: true,
    tokensPerMinute: 123_456,
    history: [],
    turns: 7,
    toolCounts: emptyToolCounts(),
    recentTools: [],
    avatar: { skin: 1, hair: 3, hairStyle: 2, hue: 203 },
    startedAt: NOW - 95 * 60_000,
    lastActivityAt: NOW - 4000,
    ...overrides,
  };
}

function state(sessions: SessionView[], overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    generatedAt: NOW,
    quotas: {
      claude: { fiveHour: { usedPercent: 41.6, resetsAt: NOW + 90 * 60_000 }, sevenDay: null, source: "statusline", observedAt: NOW },
      codex: noQuota(),
    },
    sessions,
    totals: { costUsd: 12.345, tokensPerMinute: 999, sessions: sessions.length, working: 1 },
    device: { connected: false, path: null },
    moodThresholds: MOOD_THRESHOLDS,
    ...overrides,
  };
}

/** Pire cas réaliste : chaque champ à sa valeur maximale, chaque libellé à sa longueur maximale. */
function worstCaseSession(index: number, label: string): SessionView {
  const hugeCount = 999_999_999_999;
  return session(index, "waiting", {
    sessionId: `ffffffff-ffff-ffff-ffff-ffffffffff${index}${index}`,
    name: label.repeat(40),
    project: label.repeat(40),
    model: label.repeat(40),
    toolName: label.repeat(40),
    mood: "exhausted",
    moodCause: "quota7d",
    tool: "other",
    costUsd: 9_999_999.99,
    contextPercent: 100,
    contextWindowSize: 1_000_000,
    // Au-delà de 2^31 : la carte doit les décoder sur 64 bits.
    tokens: { input: Number.MAX_SAFE_INTEGER, output: Number.MAX_SAFE_INTEGER, cacheRead: Number.MAX_SAFE_INTEGER, cacheWrite: Number.MAX_SAFE_INTEGER },
    tokensPerMinute: hugeCount,
    history: Array.from({ length: 30 }, () => hugeCount),
    turns: 9_999_999,
    toolCounts: { read: 99_999, write: 99_999, run: 99_999, search: 99_999, delegate: 99_999, think: 99_999, other: 99_999 },
    avatar: { skin: 3, hair: 5, hairStyle: 2, hue: 359 },
    startedAt: 0,
    lastActivityAt: 0,
  });
}

function worstCaseState(label: string): DashboardState {
  return state([1, 2, 3, 4, 5, 6].map((index) => worstCaseSession(index, label)), {
    quotas: {
      claude: { fiveHour: { usedPercent: 100, resetsAt: NOW + 300 * 60_000 }, sevenDay: { usedPercent: 100, resetsAt: NOW + 10_080 * 60_000 }, source: "statusline", observedAt: NOW },
      codex: { fiveHour: { usedPercent: 100, resetsAt: NOW + 300 * 60_000 }, sevenDay: { usedPercent: 100, resetsAt: NOW + 10_080 * 60_000 }, source: "rollout", observedAt: NOW },
    },
    totals: { costUsd: 99_999_999.99, tokensPerMinute: 999_999_999_999, sessions: 99, working: 99 },
  });
}

describe("device frame", () => {
  it("strips non-ASCII characters for bitmap fonts", () => {
    assert.equal(toAsciiLabel("café-🦉-session"), "cafe--sessio");
  });

  it("strips quotes and backslashes, which JSON would double", () => {
    assert.equal(toAsciiLabel('a"b\\c', 16), "abc");
  });

  it("announces protocol v2 with local time, quota and totals", () => {
    const frame = buildDeviceFrame(state([session(1, "working")]), 6);
    assert.equal(frame.v, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, 2);
    assert.equal(frame.t, Math.floor(NOW / 1000));
    const local = new Date(NOW);
    assert.deepEqual(frame.lt, [local.getHours(), local.getMinutes()]);
    assert.deepEqual(frame.q, [42, 90, -1, -1]);
    assert.deepEqual(frame.q2, [-1, -1, -1, -1]);
    assert.deepEqual(frame.tot, { c: 1235, r: 999, n: 1, w: 1 });
  });

  it("encodes every field of a session", () => {
    const frame = buildDeviceFrame(
      state([
        session(1, "working", {
          mood: "tired",
          moodCause: "context",
          tool: "search",
          toolName: "WebSearch",
          contextPercent: 74.6,
          toolCounts: { read: 52, write: 31, run: 40, search: 6, delegate: 3, think: 90, other: 12 },
          history: [1200, 8400],
          tokens: { input: 1520, output: 88_213, cacheRead: 15_022_918, cacheWrite: 412_877 },
        }),
      ]),
      6,
    );
    assert.deepEqual(frame.s[0], {
      id: "789053c5",
      pv: "c",
      n: "tres-long-no",
      h: 203,
      sk: 1,
      hc: 3,
      hs: 2,
      a: "w",
      m: "t",
      mc: "x",
      k: "s",
      tn: "WebSearch",
      x: 75,
      cw: 200,
      r: 123_456,
      c: 307,
      md: "Opus 5.5",
      p: "projects",
      u: 7,
      up: 95,
      ld: 4,
      ti: 1520,
      to: 88_213,
      tr: 15_022_918,
      tw: 412_877,
      tc: [52, 31, 40, 6, 3, 90, 12],
      // Deux minutes d'historique seulement : les 14 premiers points sont vides, le dernier moyenne (1200, 8400).
      hh: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4800],
    });
  });

  it("publishes exactly the fields documented in docs/serial-protocol.md, in order", () => {
    const frame = buildDeviceFrame(state([session(1, "working")]), 6);
    assert.deepEqual(Object.keys(frame), ["v", "t", "lt", "q", "q2", "tot", "s"]);
    assert.deepEqual(Object.keys(frame.tot), ["c", "r", "n", "w"]);
    assert.deepEqual(Object.keys(frame.s[0] ?? {}), [
      ...["id", "pv", "n", "h", "sk", "hc", "hs", "a", "m", "mc", "k", "tn", "x", "cw", "r", "c", "md", "p"],
      ...["u", "up", "ld", "ti", "to", "tr", "tw", "tc", "hh"],
    ]);
    assert.equal(frame.s[0]?.hh.length, 15);
  });

  it("uses -1 and '-' for unknown values", () => {
    const frame = buildDeviceFrame(
      state([session(1, "idle", { contextPercent: null, contextWindowSize: null, costUsd: null, model: null, lastActivityAt: null, tool: null, moodCause: null })]),
      6,
    );
    const [encoded] = frame.s;
    assert.ok(encoded);
    assert.equal(encoded.x, -1);
    assert.equal(encoded.cw, -1);
    assert.equal(encoded.c, -1);
    assert.equal(encoded.ld, -1);
    assert.equal(encoded.md, "");
    assert.equal(encoded.k, "-");
    assert.equal(encoded.mc, "-");
    assert.equal(encoded.tn, "");
  });

  it("orders tc like TOOL_KINDS and never exceeds seven counters", () => {
    const counts = { read: 1, write: 2, run: 3, search: 4, delegate: 5, think: 6, other: 7 };
    const [encoded] = buildDeviceFrame(state([session(1, "idle", { toolCounts: counts })]), 6).s;
    assert.deepEqual(encoded?.tc, TOOL_KINDS.map((kind) => counts[kind]));
    assert.equal(encoded?.tc.length, 7);
  });

  it("keeps the one-character codes unique and documented", () => {
    for (const codes of [ACTIVITY_CODE, MOOD_CODE, MOOD_CAUSE_CODE, TOOL_CODE, PROVIDER_CODE]) {
      const values = Object.values(codes);
      assert.equal(new Set(values).size, values.length);
      assert.ok(values.every((code) => /^[a-z]$/.test(code)));
    }
    assert.deepEqual(TOOL_KINDS.map((kind) => TOOL_CODE[kind]).join(""), "rebsdto");
    assert.deepEqual(MOOD_CAUSE_CODE, { quota5h: "q", quota7d: "w", context: "x" });
    assert.deepEqual(PROVIDER_CODE, { claude: "c", codex: "x" });
  });

  it("marks Codex sessions and carries the OpenAI quota in q2", () => {
    const frame = buildDeviceFrame(
      state([session(1, "working", { provider: "codex", sessionId: "01a17215-d68a-7770-b455-e4ed0bebb2b6" })], {
        quotas: { claude: noQuota(), codex: { fiveHour: null, sevenDay: { usedPercent: 29.4, resetsAt: NOW + 1440 * 60_000 }, source: "rollout", observedAt: NOW } },
      }),
      6,
    );
    assert.equal(frame.s[0]?.pv, "x");
    assert.equal(frame.s[0]?.id, "0bebb2b6");
    assert.deepEqual(frame.q, [-1, -1, -1, -1]);
    assert.deepEqual(frame.q2, [-1, -1, 29, 1440]);
  });

  it("keeps the END of the session id (a UUIDv7 prefix is a timestamp) and filters it like any other text", () => {
    // Huit dernières unités de code : `hij`, `\\`, `"`, `é`, puis l'emoji (deux unités) ; le filtre garde `hij` et `é` → `e`.
    const [encoded] = buildDeviceFrame(state([session(1, "idle", { sessionId: 'abcdefghij\\"é🦉' })]), 6).s;
    assert.equal(encoded?.id, "hije");
  });

  it("shows working characters first when the screen is full", () => {
    const sessions = [1, 2, 3, 4, 5, 6, 7].map((index) => session(index, index === 7 ? "working" : "idle"));
    const frame = buildDeviceFrame(state(sessions), 6);
    assert.equal(frame.s.length, 6);
    assert.equal(frame.s[0]?.a, "w");
  });

  it("stays a single ASCII line, well inside the 4 000-byte budget, for a typical frame", () => {
    const line = encodeDeviceFrame(buildDeviceFrame(state([1, 2, 3, 4, 5, 6].map((index) => session(index, "working", { history: Array.from({ length: 30 }, (_, i) => i * 100) }))), 6));
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1);
    assert.match(line, /^[\x20-\x7e]*\n$/);
    assert.ok(line.length < FRAME_BUDGET, `trame de ${line.length} octets`);
  });

  it("keeps a worst-case frame (6 sessions, maximal values and labels) under 4 000 bytes", () => {
    const line = encodeDeviceFrame(buildDeviceFrame(worstCaseState("W"), 6));
    assert.equal(JSON.parse(line).s.length, 6);
    assert.match(line, /^[\x20-\x7e]*\n$/);
    assert.ok(line.length < FRAME_BUDGET, `trame pire cas de ${line.length} octets`);
  });

  it("keeps the worst case under budget even with labels made of JSON-escaped characters", () => {
    // Régression : `"` et `\` doublent en JSON ; la trame atteignait 4 073 octets.
    for (const label of ['"', "\\"]) {
      const line = encodeDeviceFrame(buildDeviceFrame(worstCaseState(label), 6));
      assert.ok(line.length < FRAME_BUDGET, `trame de ${line.length} octets avec ${label}`);
    }
  });

  it("round-trips 64-bit token counts without loss up to 2^53 - 1", () => {
    const line = encodeDeviceFrame(buildDeviceFrame(worstCaseState("W"), 6));
    const [first] = JSON.parse(line).s;
    assert.equal(first.tr, Number.MAX_SAFE_INTEGER);
  });
});

describe("compactHistory", () => {
  it("returns 15 zeros for an empty history", () => {
    assert.deepEqual(compactHistory([]), Array.from({ length: HISTORY_POINTS }, () => 0));
  });

  it("averages consecutive minutes two by two, oldest first", () => {
    const thirty = Array.from({ length: 30 }, (_, index) => index * 10);
    // Paires (0,10) (20,30)… : moyennes 5, 25, 45… ; 5 → arrondi 5.
    assert.deepEqual(compactHistory(thirty), Array.from({ length: 15 }, (_, index) => index * 20 + 5));
  });

  it("pads missing minutes on the old side so the newest value stays last", () => {
    const compact = compactHistory([100, 300, 500]);
    assert.equal(compact.length, 15);
    // 27 zéros puis 100, 300, 500 : dernière paire (300, 500) = 400, avant-dernière (0, 100) = 50.
    assert.deepEqual(compact.slice(-2), [50, 400]);
    assert.ok(compact.slice(0, -2).every((value) => value === 0));
  });

  it("keeps only the last 30 minutes of a longer history", () => {
    const sixty = [...Array.from({ length: 30 }, () => 9999), ...Array.from({ length: 30 }, () => 20)];
    assert.deepEqual(compactHistory(sixty), Array.from({ length: 15 }, () => 20));
  });

  it("rounds each average to an integer", () => {
    assert.deepEqual(compactHistory([0, 1]).at(-1), 1);
    assert.deepEqual(compactHistory([1, 2]).at(-1), 2);
    assert.deepEqual(compactHistory([1, 1]).at(-1), 1);
    assert.ok(compactHistory([1, 2, 3, 4, 5, 6, 7]).every(Number.isInteger));
  });
});
