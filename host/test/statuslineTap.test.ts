import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const TAP = new URL("../../tap/statusline-tap.sh", import.meta.url).pathname;
const SESSION_ID = "0702150f-d8d9-4dc0-83a3-bd0c789053c5";
const PAYLOAD = JSON.stringify({ session_id: SESSION_ID, cost: { total_cost_usd: 1.5 } });

function runTap(args: string[], env: NodeJS.ProcessEnv, input = PAYLOAD) {
  return spawnSync("bash", [TAP, ...args], { input, env, encoding: "utf8" });
}

describe("statusline-tap.sh", () => {
  it("forwards stdin unchanged and keeps the wrapped command's exit code", async () => {
    const home = await mkdtemp(join(tmpdir(), "mascots-tap-"));
    const result = runTap(["bash", "-c", "cat; exit 3"], { ...process.env, MASCOTS_HOME: home });
    assert.equal(result.stdout, PAYLOAD);
    assert.equal(result.status, 3);
    assert.equal(await readFile(join(home, "spool", `${SESSION_ID}.json`), "utf8"), PAYLOAD);
  });

  it("does not leak its restrictive umask to the real statusline", async () => {
    const home = await mkdtemp(join(tmpdir(), "mascots-tap-"));
    const result = runTap(["bash", "-c", "umask"], { ...process.env, MASCOTS_HOME: home });
    const parent = spawnSync("bash", ["-c", "umask"], { encoding: "utf8" }).stdout;
    assert.equal(result.stdout, parent);
  });

  it("ignores a session_id that is not a UUID (no path traversal)", async () => {
    const home = await mkdtemp(join(tmpdir(), "mascots-tap-"));
    runTap([], { ...process.env, MASCOTS_HOME: home }, JSON.stringify({ session_id: "../../evil" }));
    assert.deepEqual(await readdir(home).catch(() => []), []);
  });

  it("still forwards when HOME is unset", () => {
    const { HOME: _home, ...env } = process.env;
    const result = runTap(["cat"], { ...env, MASCOTS_HOME: "/nonexistent/readonly" });
    assert.equal(result.stdout, PAYLOAD);
    assert.equal(result.status, 0);
  });
});
