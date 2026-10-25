import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findOpenRollouts } from "../src/sources/codexSessions.ts";

async function fakeProc(): Promise<{ procRoot: string; sessionsDir: string; rollout: string }> {
  const root = await mkdtemp(join(tmpdir(), "mascots-codex-proc-"));
  const sessionsDir = join(root, "codex", "sessions");
  const procRoot = join(root, "proc");
  const day = join(sessionsDir, "2026", "10", "25");
  await mkdir(day, { recursive: true });
  const rollout = join(day, "rollout-2026-10-25T09-03-16-01a17215-d68a-7770-b455-e4ed0bebb2b6.jsonl");
  await writeFile(rollout, "");
  await writeFile(join(day, "rollout-2026-10-09T13-18-00-old.jsonl.zst"), "");
  return { procRoot, sessionsDir, rollout };
}

async function process(procRoot: string, pid: number, comm: string, targets: Record<string, string>): Promise<void> {
  await mkdir(join(procRoot, String(pid), "fd"), { recursive: true });
  await writeFile(join(procRoot, String(pid), "comm"), `${comm}\n`);
  for (const [fd, target] of Object.entries(targets)) await symlink(target, join(procRoot, String(pid), "fd", fd));
}

describe("findOpenRollouts", () => {
  it("lists the rollouts held open by codex processes, with the parent pid", async () => {
    const { procRoot, sessionsDir, rollout } = await fakeProc();
    await process(procRoot, 5000, "codex", { "7": rollout, "8": "/dev/null" });
    await process(procRoot, 4000, "codex", { "3": rollout });
    assert.deepEqual(await findOpenRollouts(sessionsDir, procRoot), [{ path: rollout, pid: 4000 }]);
  });

  it("ignores archives, deleted files, other directories and processes that are not codex", async () => {
    const { procRoot, sessionsDir, rollout } = await fakeProc();
    const day = join(sessionsDir, "2026", "10", "25");
    await process(procRoot, 10, "codex", { "1": join(day, "rollout-2026-10-09T13-18-00-old.jsonl.zst"), "2": `${rollout} (deleted)`, "3": "/home/rony/other/rollout-x.jsonl" });
    await process(procRoot, 20, "node", { "1": rollout });
    await process(procRoot, 30, "Codex Desktop", { "1": rollout });
    await mkdir(join(procRoot, "self"));
    await writeFile(join(procRoot, "uptime"), "1 2");
    assert.deepEqual(await findOpenRollouts(sessionsDir, procRoot), [{ path: rollout, pid: 30 }]);
  });

  it("returns nothing without /proc or when fd directories are unreadable", async () => {
    assert.deepEqual(await findOpenRollouts("/home/rony/.codex/sessions", "/nonexistent/proc"), []);
    const { procRoot, sessionsDir } = await fakeProc();
    await mkdir(join(procRoot, "77"), { recursive: true });
    await writeFile(join(procRoot, "77", "comm"), "codex\n");
    assert.deepEqual(await findOpenRollouts(sessionsDir, procRoot), []);
  });
});
