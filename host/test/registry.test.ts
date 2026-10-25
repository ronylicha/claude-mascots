import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readFile as readFileAsync } from "node:fs/promises";
import { isSessionProcessAlive, parseProcStartTime, parseRegistryEntry, readActiveSessions } from "../src/sources/registry.ts";

describe("session registry", () => {
  it("parses a real registry entry and applies defaults", () => {
    const entry = parseRegistryEntry({ pid: 42, sessionId: "abcdef12-3456", cwd: "/home/rony/x", status: "busy", version: "2.1.310", startedAt: 1, statusUpdatedAt: 2 });
    assert.equal(entry?.name, "abcdef12");
    assert.equal(entry?.status, "busy");
    assert.equal(parseRegistryEntry({ sessionId: "no pid" }), null);
  });

  it("rejects pid 0 and negative pids (kill(0) would target the whole process group)", () => {
    assert.equal(parseRegistryEntry({ pid: 0, sessionId: "x" }), null);
    assert.equal(parseRegistryEntry({ pid: -5, sessionId: "x" }), null);
  });

  it("extracts the start time even when the process name contains spaces and parentheses", () => {
    const stat = "4242 (claude (wrapper) x) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 339481 20 21";
    assert.equal(parseProcStartTime(stat), "339481");
  });

  it("only reads <pid>.json files, never the .key secrets, and drops dead processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mascots-registry-"));
    await writeFile(join(dir, "100.json"), JSON.stringify({ pid: 100, sessionId: "alive" }));
    await writeFile(join(dir, "200.json"), JSON.stringify({ pid: 200, sessionId: "dead" }));
    await writeFile(join(dir, "100.abc.key"), "SECRET");
    await writeFile(join(dir, "300.json"), "{partial");
    const sessions = await readActiveSessions(dir, (entry) => entry.pid === 100);
    assert.deepEqual(sessions.map((session) => session.sessionId), ["alive"]);
  });

  it("returns nothing when the registry folder does not exist", async () => {
    assert.deepEqual(await readActiveSessions("/nonexistent/mascots"), []);
  });

  it("detects the current process as alive when its start time matches", async () => {
    const procStart = parseProcStartTime(await readFileAsync(`/proc/${process.pid}/stat`, "utf8"));
    const entry = parseRegistryEntry({ pid: process.pid, sessionId: "me", procStart });
    assert.ok(entry);
    assert.equal(await isSessionProcessAlive(entry), true);
  });

  it("treats a reused pid (different start time) as a dead session", async () => {
    const entry = parseRegistryEntry({ pid: process.pid, sessionId: "ghost", procStart: "1" });
    assert.ok(entry);
    assert.equal(await isSessionProcessAlive(entry), false);
  });
});
