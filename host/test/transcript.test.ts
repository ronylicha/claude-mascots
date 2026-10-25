import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { classifyTool, displayToolName, emptyToolCounts, findTranscriptPath, TranscriptTracker } from "../src/sources/transcript.ts";
import { RECENT_TOOLS_LIMIT } from "../src/types.ts";

const NOW = Date.parse("2026-10-24T03:30:30Z");

function assistantLine(id: string, at: string, content: object[], usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 200 }): string {
  return JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage, content } });
}

describe("TranscriptTracker", () => {
  it("counts usage once per message even when each content block is its own line", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(
      [
        assistantLine("msg_1", "2026-10-24T03:30:00Z", [{ type: "thinking" }]),
        assistantLine("msg_1", "2026-10-24T03:30:00Z", [{ type: "text" }]),
        assistantLine("msg_1", "2026-10-24T03:30:01Z", [{ type: "tool_use", name: "Read" }]),
        "",
      ].join("\n"),
    );
    const stats = tracker.snapshot(NOW, 5);
    assert.deepEqual(stats.totals, { input: 10, output: 100, cacheRead: 5000, cacheWrite: 200 });
    assert.equal(stats.assistantTurns, 1);
    assert.equal(stats.lastTool, "Read");
    assert.equal(stats.lastToolKind, "read");
  });

  it("keeps a partial trailing line until the rest arrives", () => {
    const tracker = new TranscriptTracker("unused");
    const line = assistantLine("msg_2", "2026-10-24T03:30:00Z", [{ type: "tool_use", name: "Bash" }]);
    tracker.ingestText(line.slice(0, 40));
    assert.equal(tracker.snapshot(NOW, 5).assistantTurns, 0);
    tracker.ingestText(`${line.slice(40)}\n`);
    assert.equal(tracker.snapshot(NOW, 5).lastToolKind, "run");
  });

  it("buckets billable tokens per minute and excludes cache reads", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(
      `${assistantLine("a", "2026-10-24T03:28:10Z", [])}\n${assistantLine("b", "2026-10-24T03:30:05Z", [])}\n${assistantLine("c", "2026-10-24T03:30:20Z", [])}\n`,
    );
    // 10 (entrée) + 200 (écriture cache) + 100 (sortie) = 310 par message ; minute courante = 2 messages.
    assert.deepEqual(tracker.snapshot(NOW, 3).perMinute, [310, 0, 620]);
  });

  it("marks thinking after a tool as the current activity", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${assistantLine("a", "2026-10-24T03:30:00Z", [{ type: "tool_use", name: "Edit" }])}\n${assistantLine("b", "2026-10-24T03:30:09Z", [{ type: "thinking" }])}\n`);
    const stats = tracker.snapshot(NOW, 1);
    assert.equal(stats.lastToolKind, "think");
    assert.equal(stats.lastActivityAt, Date.parse("2026-10-24T03:30:09Z"));
  });

  it("ignores corrupted lines and non-object JSON without losing the following ones", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`{not json\nnull\n42\n[]\n${assistantLine("ok", "2026-10-24T03:30:00Z", [])}\n`);
    assert.equal(tracker.snapshot(NOW, 1).assistantTurns, 1);
  });

  it("decodes a multi-byte character split across two read chunks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-utf8-"));
    const file = join(dir, "s.jsonl");
    const line = assistantLine("utf8", "2026-10-24T03:30:00Z", [{ type: "tool_use", name: "Édite" }]);
    // Place le « É » (2 octets) exactement à cheval sur la frontière de 1 Mio.
    const prefixLength = (1 << 20) - Buffer.byteLength(line.slice(0, line.indexOf("É"))) - 1;
    await writeFile(file, `${" ".repeat(prefixLength - 1)}\n${line}\n`);
    const tracker = new TranscriptTracker(file);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).lastTool, "Édite");
  });

  it("starts over when the journal is replaced by a new file of any size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-inode-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, `${assistantLine("a", "2026-10-24T03:30:00Z", [])}\n`);
    const tracker = new TranscriptTracker(file);
    await tracker.refresh();
    const { rename } = await import("node:fs/promises");
    const replacement = join(dir, "new.jsonl");
    await writeFile(replacement, `${assistantLine("b", "2026-10-24T03:30:00Z", [])}\n${assistantLine("c", "2026-10-24T03:30:01Z", [])}\n`);
    await rename(replacement, file);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).assistantTurns, 2);
  });

  it("reads files incrementally and restarts when the file shrinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, `${assistantLine("a", "2026-10-24T03:30:00Z", [])}\n`);
    const tracker = new TranscriptTracker(file);
    await tracker.refresh();
    await appendFile(file, `${assistantLine("b", "2026-10-24T03:30:01Z", [])}\n`);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).assistantTurns, 2);

    await writeFile(file, `${assistantLine("z", "2026-10-24T03:30:02Z", [])}\n`);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).assistantTurns, 1);
  });
});

describe("TranscriptTracker tool statistics", () => {
  const toolLine = (id: string, at: string, name: string) => assistantLine(id, at, [{ type: "tool_use", name }]);

  it("counts every tool_use and thinking block, even when they share one message id", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(
      [
        assistantLine("msg_1", "2026-10-24T03:30:00Z", [{ type: "thinking" }]),
        assistantLine("msg_1", "2026-10-24T03:30:00Z", [{ type: "text" }]),
        toolLine("msg_1", "2026-10-24T03:30:01Z", "Read"),
        toolLine("msg_1", "2026-10-24T03:30:02Z", "Grep"),
        toolLine("msg_2", "2026-10-24T03:30:03Z", "Bash"),
        toolLine("msg_2", "2026-10-24T03:30:04Z", "mcp__plugin_playwright_playwright__browser_click"),
        toolLine("msg_3", "2026-10-24T03:30:05Z", "Agent"),
        toolLine("msg_3", "2026-10-24T03:30:06Z", "TaskCreate"),
        toolLine("msg_3", "2026-10-24T03:30:07Z", "MultiEdit"),
        "",
      ].join("\n"),
    );
    const stats = tracker.snapshot(NOW, 1);
    assert.deepEqual(stats.toolCounts, { read: 2, write: 1, run: 1, search: 1, delegate: 1, think: 1, other: 1 });
    // Les tokens, eux, restent dédoublonnés par message : 3 messages, pas 9 lignes.
    assert.equal(stats.assistantTurns, 3);
    assert.equal(stats.totals.output, 300);
  });

  it("counts several tool_use blocks written in the same line", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${assistantLine("m", "2026-10-24T03:30:00Z", [{ type: "tool_use", name: "Read" }, { type: "tool_use", name: "Read" }, { type: "thinking" }])}\n`);
    const stats = tracker.snapshot(NOW, 1);
    assert.equal(stats.toolCounts.read, 2);
    assert.equal(stats.toolCounts.think, 1);
    assert.deepEqual(
      stats.recentTools.map((tool) => tool.name),
      ["Read", "Read"],
    );
  });

  it("lists recent tools newest first with display names and journal timestamps", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(
      [
        toolLine("a", "2026-10-24T03:30:00Z", "Bash"),
        assistantLine("b", "2026-10-24T03:30:05Z", [{ type: "thinking" }]),
        toolLine("c", "2026-10-24T03:30:10Z", "mcp__serena__find_symbol"),
        "",
      ].join("\n"),
    );
    assert.deepEqual(tracker.snapshot(NOW, 1).recentTools, [
      { name: "find_symbol", kind: "other", at: Date.parse("2026-10-24T03:30:10Z") },
      { name: "Bash", kind: "run", at: Date.parse("2026-10-24T03:30:00Z") },
    ]);
  });

  it("keeps at most RECENT_TOOLS_LIMIT calls and drops the oldest", () => {
    const tracker = new TranscriptTracker("unused");
    const total = RECENT_TOOLS_LIMIT + 4;
    tracker.ingestText(`${Array.from({ length: total }, (_, index) => toolLine(`m${index}`, `2026-10-24T03:30:${String(index).padStart(2, "0")}Z`, `Tool${index}`)).join("\n")}\n`);
    const stats = tracker.snapshot(NOW, 1);
    assert.equal(stats.recentTools.length, RECENT_TOOLS_LIMIT);
    assert.equal(stats.recentTools[0]?.name, `Tool${total - 1}`);
    assert.equal(stats.recentTools.at(-1)?.name, `Tool${total - RECENT_TOOLS_LIMIT}`);
    // Le compteur, lui, n'est pas plafonné.
    assert.equal(stats.toolCounts.other, total);
  });

  it("gives a call from an undated line the last known activity time", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${toolLine("a", "2026-10-24T03:30:00Z", "Read")}\n${JSON.stringify({ type: "assistant", message: { id: "b", content: [{ type: "tool_use", name: "Edit" }] } })}\n`);
    const [latest] = tracker.snapshot(NOW, 1).recentTools;
    assert.deepEqual(latest, { name: "Edit", kind: "write", at: Date.parse("2026-10-24T03:30:00Z") });
  });

  it("ignores malformed content blocks without losing the valid ones", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${assistantLine("a", "2026-10-24T03:30:00Z", [null as unknown as object, { type: "tool_use" }, { type: "tool_use", name: 42 }, { type: "tool_use", name: "Write" }])}\n`);
    const stats = tracker.snapshot(NOW, 1);
    assert.equal(stats.toolCounts.write, 1);
    assert.equal(stats.recentTools.length, 1);
  });

  it("hands out snapshots that cannot alter the tracker", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${toolLine("a", "2026-10-24T03:30:00Z", "Read")}\n`);
    const first = tracker.snapshot(NOW, 1);
    first.toolCounts.read = 99;
    first.recentTools.length = 0;
    const second = tracker.snapshot(NOW, 1);
    assert.equal(second.toolCounts.read, 1);
    assert.equal(second.recentTools.length, 1);
  });

  it("clears the tool statistics when the journal is truncated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-tools-"));
    const file = join(dir, "s.jsonl");
    await writeFile(file, `${toolLine("a", "2026-10-24T03:30:00Z", "Read")}\n${toolLine("b", "2026-10-24T03:30:01Z", "Bash")}\n`);
    const tracker = new TranscriptTracker(file);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).toolCounts.read, 1);

    await writeFile(file, `${toolLine("z", "2026-10-24T03:30:02Z", "Edit")}\n`);
    await tracker.refresh();
    const stats = tracker.snapshot(NOW, 1);
    assert.deepEqual(stats.toolCounts, { ...emptyToolCounts(), write: 1 });
    assert.deepEqual(
      stats.recentTools.map((tool) => tool.name),
      ["Edit"],
    );
  });
});

describe("displayToolName", () => {
  it("keeps only the last segment of MCP tool names", () => {
    assert.equal(displayToolName("mcp__serena__find_symbol"), "find_symbol");
    assert.equal(displayToolName("mcp__plugin_playwright_playwright__browser_click"), "browser_click");
    assert.equal(displayToolName("Bash"), "Bash");
  });
});

describe("classifyTool", () => {
  it("maps Claude Code tools to visual categories", () => {
    assert.equal(classifyTool("Grep"), "read");
    assert.equal(classifyTool("MultiEdit"), "write");
    assert.equal(classifyTool("Bash"), "run");
    assert.equal(classifyTool("WebSearch"), "search");
    assert.equal(classifyTool("mcp__plugin_playwright_playwright__browser_click"), "search");
    assert.equal(classifyTool("Agent"), "delegate");
    assert.equal(classifyTool("TaskCreate"), "other");
  });
});

describe("findTranscriptPath", () => {
  it("finds the journal in any project folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "mascots-projects-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "-home-rony-x"));
    const id = "0702150f-d8d9-4dc0-83a3-bd0c789053c5";
    await writeFile(join(root, "-home-rony-x", `${id}.jsonl`), "");
    assert.equal(await findTranscriptPath(root, id), join(root, "-home-rony-x", `${id}.jsonl`));
    assert.equal(await findTranscriptPath(root, "absent"), null);
  });
});

describe("TranscriptTracker usage reliability", () => {
  it("trusts usage as long as every message read at least one input token", () => {
    const tracker = new TranscriptTracker("unused");
    tracker.ingestText(`${assistantLine("a", "2026-10-24T03:30:00Z", [], { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 })}\n`);
    assert.equal(tracker.snapshot(NOW, 1).usageReliable, true);
  });

  it("flags the session when a message reports no input at all (proxy that drops usage)", () => {
    const tracker = new TranscriptTracker("unused");
    // Forme exacte relevée sur ghostcli.cloud : entrée et cache à 0, sortie minuscule.
    const broken = { input_tokens: 0, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    tracker.ingestText(`${assistantLine("ok", "2026-10-24T03:30:00Z", [])}\n${assistantLine("ko", "2026-10-24T03:30:05Z", [], broken)}\n${assistantLine("ok2", "2026-10-24T03:30:09Z", [])}\n`);
    const stats = tracker.snapshot(NOW, 1);
    assert.equal(stats.usageReliable, false);
    // Les chiffres restent additionnés tels quels : c'est à l'affichage de dire qu'ils ne sont pas mesurés.
    assert.equal(stats.totals.output, 234);
    assert.equal(stats.assistantTurns, 3);
  });

  it("forgets the flag with the rest of the statistics when the journal is replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-reliable-"));
    const file = join(dir, "s.jsonl");
    const broken = { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    await writeFile(file, `${assistantLine("ko", "2026-10-24T03:30:00Z", [], broken)}\n`);
    const tracker = new TranscriptTracker(file);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).usageReliable, false);
    // Nouveau fichier (nouvel inode) : le suivi repart de zéro, comme pour les autres statistiques.
    const { rename } = await import("node:fs/promises");
    const replacement = join(dir, "new.jsonl");
    await writeFile(replacement, `${assistantLine("ok", "2026-10-24T03:30:02Z", [])}\n`);
    await rename(replacement, file);
    await tracker.refresh();
    assert.equal(tracker.snapshot(NOW, 1).usageReliable, true);
  });
});
