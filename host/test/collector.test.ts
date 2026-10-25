import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { avatarFor } from "../src/domain/avatar.ts";
import { Collector } from "../src/domain/collector.ts";
import { emptyToolCounts } from "../src/sources/transcript.ts";

const SESSION_ID = "0702150f-d8d9-4dc0-83a3-bd0c789053c5";
const NOW = Date.parse("2026-10-24T03:30:30Z");

async function fakeClaudeHome(): Promise<{ root: string; collector: Collector }> {
  const root = await mkdtemp(join(tmpdir(), "mascots-home-"));
  const registryDir = join(root, "sessions");
  const projectsDir = join(root, "projects");
  const spoolDir = join(root, "mascots", "spool");
  await Promise.all([mkdir(registryDir), mkdir(join(projectsDir, "-home-rony-projects"), { recursive: true }), mkdir(spoolDir, { recursive: true })]);

  await writeFile(
    join(registryDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: SESSION_ID, cwd: "/home/rony/projects", name: "projects-50", status: "busy", version: "2.1.310", startedAt: NOW - 600_000, statusUpdatedAt: NOW }),
  );
  await writeFile(
    join(projectsDir, "-home-rony-projects", `${SESSION_ID}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-24T03:30:10Z",
      message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 98, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 }, content: [{ type: "tool_use", name: "mcp__plugin_playwright_playwright__browser_click" }] },
    })}\n`,
  );
  await writeFile(
    join(spoolDir, `${SESSION_ID}.json`),
    JSON.stringify({
      session_id: SESSION_ID,
      model: { display_name: "Opus 5.5" },
      cost: { total_cost_usd: 3.0677 },
      context_window: { used_percentage: 75, context_window_size: 1_000_000 },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: Math.floor(NOW / 1000) + 3600 }, seven_day: { used_percentage: 3, resets_at: Math.floor(NOW / 1000) + 86_400 } },
    }),
  );

  const collector = new Collector({
    registryDir,
    projectsDir,
    spoolDir,
    quotaCacheFile: join(root, "absent.json"),
    codexSessionsDir: join(root, "codex", "sessions"),
    procRoot: join(root, "proc"),
    codexScanIntervalMs: 0,
    historyMinutes: 10,
    sleepAfterMs: 600_000,
    quotaStaleMs: Number.MAX_SAFE_INTEGER,
  });
  return { root, collector };
}

describe("Collector", () => {
  it("merges registry, transcript and statusline snapshot into one character", async () => {
    const { collector } = await fakeClaudeHome();
    const state = await collector.collect(NOW, { connected: false, path: null });

    assert.equal(state.sessions.length, 1);
    const [session] = state.sessions;
    assert.ok(session);
    assert.equal(session.provider, "claude");
    assert.equal(session.name, "projects-50");
    assert.equal(session.project, "projects");
    assert.equal(session.model, "Opus 5.5");
    assert.equal(session.activity, "working");
    assert.equal(session.tool, "search");
    assert.equal(session.toolName, "browser_click");
    assert.equal(session.mood, "tired");
    assert.equal(session.costUsd, 3.0677);
    assert.deepEqual(session.tokens, { input: 2, output: 98, cacheRead: 9000, cacheWrite: 400 });
    assert.equal(session.history.at(-1), 500);
    assert.equal(session.tokensPerMinute, 100);

    assert.equal(state.quotas.claude.source, "statusline");
    assert.equal(state.quotas.claude.fiveHour?.usedPercent, 12);
    assert.deepEqual(state.totals, { costUsd: 3.0677, tokensPerMinute: 100, sessions: 1, working: 1 });
  });

  it("fills the detail fields: cwd, status, mood cause, context window, turns, tools and avatar", async () => {
    const { collector } = await fakeClaudeHome();
    const state = await collector.collect(NOW, { connected: false, path: null });
    const [session] = state.sessions;
    assert.ok(session);

    assert.equal(session.cwd, "/home/rony/projects");
    assert.equal(session.status, "busy");
    assert.equal(session.mood, "tired");
    assert.equal(session.moodCause, "context");
    assert.equal(session.contextWindowSize, 1_000_000);
    assert.equal(session.turns, 1);
    assert.deepEqual(session.toolCounts, { ...emptyToolCounts(), search: 1 });
    assert.deepEqual(session.recentTools, [{ name: "browser_click", kind: "search", at: Date.parse("2026-10-24T03:30:10Z") }]);
    assert.deepEqual(session.avatar, avatarFor(SESSION_ID));
  });

  it("falls back to neutral detail fields before the first journal line and statusline", async () => {
    const root = await mkdtemp(join(tmpdir(), "mascots-empty-"));
    const registryDir = join(root, "sessions");
    await Promise.all([mkdir(registryDir), mkdir(join(root, "projects")), mkdir(join(root, "spool"))]);
    await writeFile(
      join(registryDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: SESSION_ID, cwd: "/home/rony/neuf", name: "neuf", status: "idle", version: "2.1.310", startedAt: NOW - 1000, statusUpdatedAt: NOW }),
    );
    const collector = new Collector({ registryDir, projectsDir: join(root, "projects"), spoolDir: join(root, "spool"), quotaCacheFile: join(root, "absent.json"), codexSessionsDir: join(root, "codex"), procRoot: join(root, "proc"), codexScanIntervalMs: 0, historyMinutes: 10, sleepAfterMs: 600_000, quotaStaleMs: 1 });
    const [session] = (await collector.collect(NOW, { connected: false, path: null })).sessions;
    assert.ok(session);

    assert.equal(session.status, "idle");
    assert.equal(session.moodCause, null);
    assert.equal(session.contextWindowSize, null);
    assert.equal(session.turns, 0);
    assert.deepEqual(session.toolCounts, emptyToolCounts());
    assert.deepEqual(session.recentTools, []);
  });

  it("returns an empty troupe when no Claude session is running", async () => {
    const collector = new Collector({
      registryDir: "/nonexistent/sessions",
      projectsDir: "/nonexistent/projects",
      spoolDir: "/nonexistent/spool",
      quotaCacheFile: "/nonexistent/cache.json",
      codexSessionsDir: "/nonexistent/codex",
      procRoot: "/nonexistent/proc",
      codexScanIntervalMs: 0,
      historyMinutes: 5,
      sleepAfterMs: 1,
      quotaStaleMs: 1,
    });
    const state = await collector.collect(NOW, { connected: true, path: "/dev/ttyUSB0" });
    assert.equal(state.sessions.length, 0);
    assert.equal(state.quotas.claude.source, "none");
    assert.equal(state.quotas.codex.source, "none");
    assert.equal(state.device.path, "/dev/ttyUSB0");
  });
});

describe("Collector usage reliability", () => {
  it("withholds context and cost derived from usage an upstream proxy never transmitted", async () => {
    const { root, collector } = await fakeClaudeHome();
    await writeFile(
      join(root, "projects", "-home-rony-projects", `${SESSION_ID}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-10-24T03:30:10Z",
        message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text" }] },
      })}\n`,
    );
    const state = await collector.collect(NOW, { connected: false, path: null });
    const [session] = state.sessions;
    assert.ok(session);
    assert.equal(session.usageReliable, false);
    // La barre d'état annonçait 75 % et 3,07 $ : calculés sur des zéros, ils ne sont pas publiés.
    assert.equal(session.contextPercent, null);
    assert.equal(session.costUsd, null);
    assert.equal(session.moodCause, null);
    assert.deepEqual(session.tokens, { input: 0, output: 34, cacheRead: 0, cacheWrite: 0 });
    assert.equal(state.totals.costUsd, 0);
    // Le quota, lui, vient du compte et reste exploitable.
    assert.equal(state.quotas.claude.fiveHour?.usedPercent, 12);
  });

  it("publishes usageReliable: true for an ordinary session", async () => {
    const { collector } = await fakeClaudeHome();
    const [session] = (await collector.collect(NOW, { connected: false, path: null })).sessions;
    assert.equal(session?.usageReliable, true);
    assert.equal(session?.contextPercent, 75);
  });
});

const CODEX_ID = "01a17215-d68a-7770-b455-e4ed0bebb2b6";

function rolloutLine(type: string, timestamp: string, payload: object): string {
  return JSON.stringify({ timestamp, type, payload });
}

/** Un faux /proc : un processus `codex` qui tient le rollout ouvert, un autre qui ne tient qu'une archive. */
async function fakeCodexHome(root: string, options: { subagent?: boolean; archiveOnly?: boolean } = {}): Promise<string> {
  const sessionsDir = join(root, "codex", "sessions", "2026", "10", "25");
  const procRoot = join(root, "proc");
  await mkdir(sessionsDir, { recursive: true });
  const rollout = join(sessionsDir, `rollout-2026-10-25T09-03-16-${CODEX_ID}.jsonl`);
  const rateLimits = { limit_id: "codex", primary: { used_percent: 29, window_minutes: 10_080, resets_at: Math.floor(NOW / 1000) + 86_400 }, secondary: null, plan_type: "pro" };
  await writeFile(
    rollout,
    [
      rolloutLine("session_meta", "2026-10-24T03:20:00.000Z", {
        id: CODEX_ID,
        timestamp: "2026-10-24T03:20:00.000Z",
        cwd: "/home/rony/projects/arc",
        originator: "codex_exec",
        cli_version: "0.164.0",
        source: options.subagent ? { subagent: { thread_spawn: { parent_thread_id: "x", depth: 1 } } } : "exec",
      }),
      rolloutLine("turn_context", "2026-10-24T03:20:31.000Z", { cwd: "/home/rony/projects/arc", model: "gpt-6.1-sol", effort: "high" }),
      rolloutLine("event_msg", "2026-10-24T03:30:00.000Z", { type: "task_started", turn_id: "t1", model_context_window: 475_000 }),
      rolloutLine("response_item", "2026-10-24T03:30:05.000Z", { type: "reasoning", summary: [] }),
      rolloutLine("response_item", "2026-10-24T03:30:10.000Z", { type: "custom_tool_call", name: "exec", input: "text(await tools.exec_command({cmd:'ls'}));" }),
      rolloutLine("event_msg", "2026-10-24T03:30:12.000Z", {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 205_354, cached_input_tokens: 205_056, cache_write_input_tokens: 0, output_tokens: 232, reasoning_output_tokens: 28, total_tokens: 205_586 },
          last_token_usage: { input_tokens: 205_354, cached_input_tokens: 205_056, cache_write_input_tokens: 0, output_tokens: 232, reasoning_output_tokens: 28, total_tokens: 205_586 },
          model_context_window: 475_000,
        },
        rate_limits: rateLimits,
      }),
      "",
    ].join("\n"),
  );
  const archive = join(sessionsDir, "rollout-2026-10-09T13-18-00-old.jsonl.zst");
  await writeFile(archive, "zst");
  await mkdir(join(procRoot, "4242", "fd"), { recursive: true });
  await writeFile(join(procRoot, "4242", "comm"), "codex\n");
  await symlink(options.archiveOnly ? archive : rollout, join(procRoot, "4242", "fd", "7"));
  await symlink(archive, join(procRoot, "4242", "fd", "8"));
  await mkdir(join(procRoot, "99", "fd"), { recursive: true });
  await writeFile(join(procRoot, "99", "comm"), "node\n");
  await symlink(rollout, join(procRoot, "99", "fd", "3"));
  return rollout;
}

describe("Collector Codex", () => {
  it("turns a rollout held open by a codex process into a character with tokens, context and the OpenAI quota", async () => {
    const { root, collector } = await fakeClaudeHome();
    await fakeCodexHome(root);
    const state = await collector.collect(NOW, { connected: false, path: null });

    assert.equal(state.sessions.length, 2);
    const codex = state.sessions.find((session) => session.provider === "codex");
    assert.ok(codex);
    assert.equal(codex.sessionId, CODEX_ID);
    assert.equal(codex.pid, 4242);
    assert.equal(codex.name, "arc-b2b6");
    assert.equal(codex.project, "arc");
    assert.equal(codex.cwd, "/home/rony/projects/arc");
    assert.equal(codex.version, "0.164.0");
    assert.equal(codex.model, "gpt-6.1-sol");
    assert.equal(codex.status, "busy");
    assert.equal(codex.activity, "working");
    assert.equal(codex.tool, "run");
    assert.equal(codex.toolName, "exec_command");
    assert.equal(codex.costUsd, null);
    assert.equal(codex.startedAt, Date.parse("2026-10-24T03:20:00.000Z"));
    assert.deepEqual(codex.tokens, { input: 298, output: 232, cacheRead: 205_056, cacheWrite: 0 });
    assert.equal(codex.turns, 1);
    assert.equal(codex.contextWindowSize, 475_000);
    assert.ok(Math.abs((codex.contextPercent ?? 0) - 43.28) < 0.01);
    assert.deepEqual(codex.toolCounts, { ...emptyToolCounts(), run: 1, think: 1 });
    assert.equal(codex.usageReliable, true);

    assert.equal(state.quotas.codex.source, "rollout");
    assert.equal(state.quotas.codex.fiveHour, null);
    assert.equal(state.quotas.codex.sevenDay?.usedPercent, 29);
    assert.equal(state.quotas.codex.observedAt, Date.parse("2026-10-24T03:30:12.000Z"));
    // Le quota Anthropic reste celui de la barre d'état : les deux comptes ne se mélangent pas.
    assert.equal(state.quotas.claude.fiveHour?.usedPercent, 12);
    assert.equal(state.sessions[0]?.provider, "codex", "la session Codex a démarré avant celle de Claude");
  });

  it("gives each session the mood of its own account's quota", async () => {
    const { root, collector } = await fakeClaudeHome();
    const rollout = await fakeCodexHome(root);
    await writeFile(rollout, (await readFile(rollout, "utf8")).replace('"used_percent":29', '"used_percent":90'));
    const state = await collector.collect(NOW, { connected: false, path: null });
    const codex = state.sessions.find((session) => session.provider === "codex");
    const claude = state.sessions.find((session) => session.provider === "claude");
    assert.equal(codex?.moodCause, "quota7d");
    assert.equal(codex?.mood, "worried");
    // Claude : quota à 12 % et 3 %, contexte à 75 % → fatigue, pas inquiétude.
    assert.equal(claude?.moodCause, "context");
  });

  it("ignores sub-agent threads and compressed archives held open by the daemon", async () => {
    const { root, collector } = await fakeClaudeHome();
    await fakeCodexHome(root, { subagent: true });
    const state = await collector.collect(NOW, { connected: false, path: null });
    assert.deepEqual(state.sessions.map((session) => session.provider), ["claude"]);
    // Le quota lu dans le rollout du sous-agent vaut quand même pour le compte.
    assert.equal(state.quotas.codex.source, "rollout");
  });

  it("sees no Codex session when the codex process only holds an archive", async () => {
    const { root, collector } = await fakeClaudeHome();
    await fakeCodexHome(root, { archiveOnly: true });
    const state = await collector.collect(NOW, { connected: false, path: null });
    assert.deepEqual(state.sessions.map((session) => session.provider), ["claude"]);
    assert.equal(state.quotas.codex.source, "none");
  });
});
