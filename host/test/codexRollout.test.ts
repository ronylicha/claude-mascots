import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CodexRolloutTracker, innerToolNames, parseCodexRateLimits } from "../src/sources/codexRollout.ts";
import { emptyToolCounts } from "../src/sources/transcript.ts";

const NOW = Date.parse("2026-10-24T03:31:00Z");
const ID = "01a17215-d68a-7770-b455-e4ed0bebb2b6";

const line = (type: string, timestamp: string, payload: object): string => JSON.stringify({ timestamp, type, payload });

function usage(input: number, cached: number, output: number, reasoning = 0, cacheWrite = 0): object {
  return { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: cacheWrite, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output };
}

function tokenCount(at: string, total: object, last: object, window = 475_000, rateLimits: object | null = null): string {
  return line("event_msg", at, { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: window }, rate_limits: rateLimits });
}

const META = line("session_meta", "2026-10-24T03:20:30.000Z", { id: ID, timestamp: "2026-10-24T03:20:30.000Z", cwd: "/home/rony/projects/arc", originator: "codex_cli_rs", cli_version: "0.164.0", source: "cli" });

function tracked(lines: string[]): CodexRolloutTracker {
  const tracker = new CodexRolloutTracker("unused");
  tracker.ingestText(`${lines.join("\n")}\n`);
  return tracker;
}

describe("parseCodexRateLimits", () => {
  it("files windows by duration: a Pro plan only has a weekly window", () => {
    const quota = parseCodexRateLimits({ primary: { used_percent: 29, window_minutes: 10_080, resets_at: 1_792_874_708 }, secondary: null }, NOW);
    assert.deepEqual(quota, { fiveHour: null, sevenDay: { usedPercent: 29, resetsAt: 1_792_874_708_000 }, observedAt: NOW });
  });

  it("maps a Plus plan's 5-hour primary and weekly secondary windows whatever their order", () => {
    const quota = parseCodexRateLimits({ primary: { used_percent: 61.5, window_minutes: 10_080, resets_at: 2 }, secondary: { used_percent: 12, window_minutes: 300, resets_at: 1 } }, NOW);
    assert.equal(quota?.fiveHour?.usedPercent, 12);
    assert.equal(quota?.sevenDay?.usedPercent, 61.5);
  });

  it("returns null without any usable window", () => {
    assert.equal(parseCodexRateLimits(null, NOW), null);
    assert.equal(parseCodexRateLimits({ primary: { used_percent: "x" } }, NOW), null);
    assert.equal(parseCodexRateLimits({ limit_id: "codex", primary: null, secondary: null }, NOW), null);
  });
});

describe("innerToolNames", () => {
  it("extracts the tools a Codex Desktop JavaScript cell really calls", () => {
    assert.deepEqual(innerToolNames("text(await tools.exec_command({cmd:'ls'})); await tools.apply_patch ({patch}); tools.web__run("), ["exec_command", "apply_patch", "web__run"]);
    assert.deepEqual(innerToolNames("const x = 1 + 1; text(x);"), []);
  });
});

describe("CodexRolloutTracker", () => {
  it("reads the identity from the first session_meta and the model from turn_context", () => {
    const tracker = tracked([
      META,
      line("session_meta", "2026-10-24T03:20:31.000Z", { id: "parent", cwd: "/elsewhere", source: "vscode" }),
      line("turn_context", "2026-10-24T03:20:31.000Z", { cwd: "/home/rony/projects/arc", model: "gpt-6.1-sol" }),
    ]);
    const snapshot = tracker.snapshot(NOW, 5);
    assert.deepEqual(snapshot.meta, { sessionId: ID, cwd: "/home/rony/projects/arc", startedAt: Date.parse("2026-10-24T03:20:30.000Z"), version: "0.164.0", originator: "codex_cli_rs", isSubagent: false });
    assert.equal(snapshot.model, "gpt-6.1-sol");
    assert.equal(snapshot.status, "idle");
  });

  it("flags threads spawned by another agent", () => {
    const meta = line("session_meta", "2026-10-24T03:20:30.000Z", { id: ID, timestamp: "2026-10-24T03:20:30.000Z", cwd: "/x", source: { subagent: { thread_spawn: { parent_thread_id: "p", depth: 1 } } } });
    assert.equal(tracked([meta]).snapshot(NOW, 5).meta.isSubagent, true);
  });

  it("is busy between task_started and task_complete, and idle once every open turn has completed", () => {
    const tracker = tracked([
      META,
      line("event_msg", "2026-10-24T03:30:00.000Z", { type: "task_started", turn_id: "root", root_turn_id: "root", model_context_window: 475_000 }),
      line("event_msg", "2026-10-24T03:30:01.000Z", { type: "task_started", turn_id: "child", root_turn_id: "root" }),
      line("event_msg", "2026-10-24T03:30:20.000Z", { type: "task_complete", turn_id: "child", root_turn_id: "root" }),
    ]);
    let snapshot = tracker.snapshot(NOW, 5);
    assert.equal(snapshot.status, "busy");
    // Dernier changement de statut : le second task_started ; la fin du tour enfant ne change rien, le parent court toujours.
    assert.equal(snapshot.statusUpdatedAt, Date.parse("2026-10-24T03:30:01.000Z"));
    assert.equal(snapshot.contextWindowSize, 475_000);
    tracker.ingestText(`${line("event_msg", "2026-10-24T03:30:40.000Z", { type: "task_complete", turn_id: "root", root_turn_id: "root" })}\n`);
    snapshot = tracker.snapshot(NOW, 5);
    assert.equal(snapshot.status, "idle");
    assert.equal(snapshot.stats.lastActivityAt, Date.parse("2026-10-24T03:30:40.000Z"));
  });

  it("goes idle on turn_aborted without a turn id", () => {
    const tracker = tracked([META, line("event_msg", "2026-10-24T03:30:00.000Z", { type: "task_started", turn_id: "a" }), line("event_msg", "2026-10-24T03:30:05.000Z", { type: "turn_aborted", reason: "interrupted" })]);
    assert.equal(tracker.snapshot(NOW, 5).status, "idle");
  });

  it("waits for the human on approval requests and user-input questions, until the model answers again", () => {
    const tracker = tracked([
      META,
      line("event_msg", "2026-10-24T03:30:00.000Z", { type: "task_started", turn_id: "a" }),
      line("event_msg", "2026-10-24T03:30:02.000Z", { type: "exec_approval_request", call_id: "c1", command: ["rm", "-rf", "x"] }),
    ]);
    assert.equal(tracker.snapshot(NOW, 5).status, "waiting-for-approval");
    tracker.ingestText(`${line("response_item", "2026-10-24T03:30:09.000Z", { type: "function_call_output", call_id: "c1", output: "ok" })}\n`);
    assert.equal(tracker.snapshot(NOW, 5).status, "busy");
    tracker.ingestText(`${line("response_item", "2026-10-24T03:30:10.000Z", { type: "function_call", name: "request_user_input_async", arguments: "{}" })}\n`);
    assert.equal(tracker.snapshot(NOW, 5).status, "waiting-for-approval");
  });

  it("counts only the growth of the cumulative totals and measures the context from the last call", () => {
    const tracker = tracked([
      META,
      tokenCount("2026-10-24T03:30:12.000Z", usage(45_580, 0, 5), usage(45_580, 0, 5), 258_400),
      tokenCount("2026-10-24T03:30:30.000Z", usage(250_934, 204_416, 45), usage(205_354, 204_416, 40, 12), 258_400),
      // Rafraîchissement du seul quota : aucun token nouveau, pas de tour supplémentaire.
      tokenCount("2026-10-24T03:30:31.000Z", usage(250_934, 204_416, 45), usage(205_354, 204_416, 40, 12), 258_400),
    ]);
    const snapshot = tracker.snapshot(NOW, 5);
    assert.deepEqual(snapshot.stats.totals, { input: 250_934 - 204_416, output: 45, cacheRead: 204_416, cacheWrite: 0 });
    assert.equal(snapshot.stats.assistantTurns, 2);
    assert.equal(snapshot.contextWindowSize, 258_400);
    // (205 354 + 40 − 12 réflexion) / 258 400.
    assert.ok(Math.abs((snapshot.contextPercent ?? 0) - 79.48) < 0.01);
    // La courbe (entrée non cachée + sortie) : 45 585 à 03:30 puis 938 + 40.
    assert.equal(snapshot.stats.perMinute.at(-2), 45_585 + 938 + 40);
    assert.equal(snapshot.stats.usageReliable, true);
  });

  it("ignores the opening token_count whose components are all zero (real Codex rollouts) and stays reliable", () => {
    const tracker = tracked([
      META,
      line("event_msg", "2026-10-24T03:29:00.000Z", {
        type: "token_count",
        info: { total_token_usage: { ...usage(0, 0, 0), total_tokens: 10_741 }, last_token_usage: { ...usage(0, 0, 0), total_tokens: 10_741 }, model_context_window: null },
        rate_limits: null,
      }),
      tokenCount("2026-10-24T03:30:12.000Z", usage(45_580, 0, 5), usage(45_580, 0, 5), 258_400),
    ]);
    const snapshot = tracker.snapshot(NOW, 5);
    assert.equal(snapshot.stats.usageReliable, true);
    assert.equal(snapshot.stats.assistantTurns, 1);
    assert.deepEqual(snapshot.stats.totals, { input: 45_580, output: 5, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Math.abs((snapshot.contextPercent ?? 0) - 17.64) < 0.01);
  });

  it("does not stay busy forever because of a turn that was never completed", () => {
    const tracker = tracked([
      META,
      line("event_msg", "2026-10-20T10:00:00.000Z", { type: "task_started", turn_id: "lost", root_turn_id: "lost" }),
      line("event_msg", "2026-10-24T03:30:00.000Z", { type: "task_started", turn_id: "root2", root_turn_id: "root2" }),
      line("event_msg", "2026-10-24T03:30:01.000Z", { type: "task_started", turn_id: "child", root_turn_id: "root2" }),
      line("event_msg", "2026-10-24T03:30:40.000Z", { type: "task_complete", turn_id: "root2", root_turn_id: "root2" }),
    ]);
    assert.equal(tracker.snapshot(NOW, 5).status, "idle");
  });

  it("keeps the previous quota when a token_count line cannot be dated", () => {
    const tracker = tracked([
      META,
      tokenCount("2026-10-24T03:30:12.000Z", usage(10, 0, 1), usage(10, 0, 1), 1000, { primary: { used_percent: 10, window_minutes: 10_080, resets_at: 1 } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 99, window_minutes: 10_080, resets_at: 2 } } } }),
    ]);
    assert.equal(tracker.snapshot(NOW, 5).quota?.sevenDay?.usedPercent, 10);
  });

  it("treats a counter that goes backwards as a fresh baseline instead of negative tokens", () => {
    const tracker = tracked([META, tokenCount("2026-10-24T03:30:12.000Z", usage(1000, 0, 10), usage(1000, 0, 10)), tokenCount("2026-10-24T03:30:13.000Z", usage(300, 0, 3), usage(300, 0, 3))]);
    assert.deepEqual(tracker.snapshot(NOW, 5).stats.totals, { input: 1300, output: 13, cacheRead: 0, cacheWrite: 0 });
  });

  it("keeps the account quota from the latest token_count, even one without usage info", () => {
    const tracker = tracked([
      META,
      tokenCount("2026-10-24T03:30:12.000Z", usage(10, 0, 1), usage(10, 0, 1), 1000, { primary: { used_percent: 10, window_minutes: 10_080, resets_at: 1 } }),
      line("event_msg", "2026-10-24T03:30:13.000Z", { type: "token_count", info: null, rate_limits: { primary: { used_percent: 11, window_minutes: 10_080, resets_at: 2 } } }),
    ]);
    const snapshot = tracker.snapshot(NOW, 5);
    assert.equal(snapshot.quota?.sevenDay?.usedPercent, 11);
    assert.equal(snapshot.quota?.observedAt, Date.parse("2026-10-24T03:30:13.000Z"));
    assert.equal(snapshot.stats.assistantTurns, 1);
  });

  it("classifies Codex tools: shell cells, patches, searches, agents and reasoning", () => {
    const tracker = tracked([
      META,
      line("response_item", "2026-10-24T03:30:01.000Z", { type: "reasoning", summary: [] }),
      line("response_item", "2026-10-24T03:30:02.000Z", { type: "custom_tool_call", name: "exec", input: "await tools.exec_command({cmd:'ls'}); await tools.apply_patch({patch:'x'});" }),
      line("response_item", "2026-10-24T03:30:03.000Z", { type: "custom_tool_call", name: "js", input: "text(1+1)" }),
      line("response_item", "2026-10-24T03:30:04.000Z", { type: "function_call", name: "spawn_agent", arguments: "{}" }),
      line("response_item", "2026-10-24T03:30:05.000Z", { type: "function_call", name: "mcp__codex_app__open_in_codex", arguments: "{}" }),
      line("response_item", "2026-10-24T03:30:06.000Z", { type: "web_search_call", action: { query: "x" } }),
      line("response_item", "2026-10-24T03:30:07.000Z", { type: "function_call", name: "read_file", arguments: "{}" }),
      line("response_item", "2026-10-24T03:30:08.000Z", { type: "message", role: "assistant", content: [] }),
    ]);
    const { stats } = tracker.snapshot(NOW, 5);
    assert.deepEqual(stats.toolCounts, { ...emptyToolCounts(), think: 1, run: 2, write: 1, delegate: 1, other: 1, search: 1, read: 1 });
    assert.equal(stats.lastTool, "read_file");
    assert.equal(stats.lastToolKind, "read");
    assert.deepEqual(
      stats.recentTools.map((tool) => tool.name),
      ["read_file", "web_search", "open_in_codex", "spawn_agent", "js", "apply_patch", "exec_command"],
    );
    assert.equal(stats.lastActivityAt, Date.parse("2026-10-24T03:30:08.000Z"));
  });

  it("starts over when the file is replaced", () => {
    const tracker = tracked([META, tokenCount("2026-10-24T03:30:12.000Z", usage(10, 0, 1), usage(10, 0, 1))]);
    (tracker as unknown as { onReset(): void }).onReset();
    const snapshot = tracker.snapshot(NOW, 5);
    assert.equal(snapshot.meta.sessionId, null);
    assert.equal(new CodexRolloutTracker("x", 42).snapshot(NOW, 5).discoveredAt, 42);
    assert.equal(snapshot.stats.assistantTurns, 0);
    assert.equal(snapshot.quota, null);
  });

  it("ignores lines that are not journal entries", () => {
    const tracker = tracked([META, "null", "[1,2]", "{broken", line("world_state", "2026-10-24T03:30:00.000Z", { full: true })]);
    assert.equal(tracker.snapshot(NOW, 5).meta.sessionId, ID);
  });
});
