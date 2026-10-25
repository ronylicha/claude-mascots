import assert from "node:assert/strict";
import { request } from "node:http";
import { after, before, describe, it } from "node:test";
import { MOOD_THRESHOLDS } from "../src/domain/behavior.ts";
import { noQuota } from "../src/sources/quota.ts";
import { DashboardServer, isLoopbackHost } from "../src/transport/httpServer.ts";

const PORT = 47_991;
const webRoot = new URL("../../web/", import.meta.url).pathname;
const sprites = new URL("../../shared/sprites.json", import.meta.url).pathname;

function get(path: string, host = `127.0.0.1:${PORT}`): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, headers: { host } }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("DashboardServer", () => {
  const server = new DashboardServer(webRoot, { "/sprites.json": sprites });
  before(() => server.listen(PORT, "127.0.0.1"));
  after(() => server.close());

  it("serves the dashboard with a strict CSP", async () => {
    const response = await get("/");
    assert.equal(response.status, 200);
    assert.match(String(response.headers["content-security-policy"]), /default-src 'self'/);
    assert.match(response.body, /Claude Mascots/);
  });

  it("serves the shared sprite file through its alias", async () => {
    const response = await get("/sprites.json");
    assert.equal(response.status, 200);
    const served = JSON.parse(response.body) as { room: { width: number }; skin_tones: unknown[] };
    assert.ok(served.room.width > 0);
    assert.ok(served.skin_tones.length > 0);
  });

  it("refuses path traversal and unknown extensions", async () => {
    assert.equal((await get("/../host/src/config.ts")).status, 404);
    assert.equal((await get("/%2e%2e/package.json")).status, 404);
  });

  it("answers 400 to an unparsable URL and keeps serving", async () => {
    assert.equal((await get("//")).status, 400);
    assert.equal((await get("/")).status, 200);
  });

  it("refuses a directory that happens to carry an allowed extension", async () => {
    const { mkdir, rm } = await import("node:fs/promises");
    const trap = `${webRoot}trap.js`;
    await mkdir(trap, { recursive: true });
    try {
      assert.equal((await get("/trap.js")).status, 404);
    } finally {
      await rm(trap, { recursive: true, force: true });
    }
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    assert.equal((await get("/api/state", "evil.example:4747")).status, 421);
  });

  it("returns the latest published state, including the mood thresholds the web page relies on", async () => {
    server.publish({ generatedAt: 1, quotas: { claude: noQuota(), codex: noQuota() }, sessions: [], totals: { costUsd: 0, tokensPerMinute: 0, sessions: 0, working: 0 }, device: { connected: false, path: null }, moodThresholds: MOOD_THRESHOLDS });
    const body = JSON.parse((await get("/api/state")).body);
    assert.equal(body.generatedAt, 1);
    assert.deepEqual(body.moodThresholds, MOOD_THRESHOLDS);
  });
});

describe("isLoopbackHost", () => {
  it("accepts loopback names with or without port", () => {
    assert.ok(isLoopbackHost("localhost:4747"));
    assert.ok(isLoopbackHost("127.0.0.1"));
    assert.ok(isLoopbackHost("[::1]:4747"));
    assert.ok(!isLoopbackHost("127.0.0.1.evil.example"));
    assert.ok(!isLoopbackHost(undefined));
  });
});
