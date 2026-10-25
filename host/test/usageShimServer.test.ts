import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { HEALTH_PATH, startUsageShim, type UsageShim } from "../src/usageShim/server.ts";
import { SseSplitter } from "../src/usageShim/sse.ts";
import { DEFAULT_SERVE_PORT, parseArgs } from "../../tap/usage-shim.ts";

const SHIM_CLI = new URL("../../tap/usage-shim.ts", import.meta.url).pathname;

function runShimCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SHIM_CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolve({ stdout, stderr, status }));
  });
}

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | null;
}

/** Amont factice qui reproduit les défauts mesurés sur le proxy : entrée à 0, sortie sous-comptée. */
class FakeUpstream {
  readonly seen: Seen[] = [];
  countStatus = 200;
  private server: Server | null = null;
  url = "";

  /** Comptage déterministe : 10 tokens par message + 1 par tranche de 4 caractères de contenu. */
  static count(body: Record<string, unknown>): number {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const chars = JSON.stringify(messages.map((message: { content?: unknown }) => message.content)).length;
    return messages.length * 10 + Math.ceil(chars / 4) + (body.system ? 100 : 0);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        this.seen.push({ url: request.url ?? "", headers: request.headers, body });
        this.route(request.url ?? "", body, response);
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server?.close(() => resolve()));
  }

  private route(url: string, body: Record<string, unknown> | null, response: import("node:http").ServerResponse): void {
    const pathname = new URL(url, "http://x").pathname;
    if (pathname === "/v1/messages/count_tokens") {
      response.writeHead(this.countStatus, { "content-type": "application/json" });
      response.end(JSON.stringify(this.countStatus === 200 ? { input_tokens: FakeUpstream.count(body ?? {}) } : { type: "error" }));
      return;
    }
    if (pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json", "x-upstream": "yes", "content-encoding": "identity" });
      response.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }));
      return;
    }
    if (pathname !== "/v1/messages") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "not_found_error" } }));
      return;
    }
    if (body?.model === "unknown-model") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Unknown model" } }));
      return;
    }
    if (body?.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_ns", type: "message", role: "assistant", model: body?.model, content: [{ type: "text", text: "bonjour le monde" }], usage: { input_tokens: 0, output_tokens: 2 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const send = (event: string, data: object) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", content: [], model: body.model, usage: { input_tokens: 0, output_tokens: 0 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    setTimeout(() => {
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Bonjour le monde, ceci est une réponse." } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      send("message_stop", { type: "message_stop" });
      response.end();
    }, 30);
  }
}

const REQUEST = {
  model: "claude-opus-5-5",
  max_tokens: 100,
  stream: true,
  system: [{ type: "text", text: "Tu es concis." }],
  tools: [{ name: "Read", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "Bonjour, dis-moi quelque chose." }],
};
const HEADERS = { "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", "accept-encoding": "gzip, br" };

async function readEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return new SseSplitter()
    .push(text)
    .filter((block) => block.data !== null)
    .map((block) => JSON.parse(block.data ?? "{}") as Record<string, unknown>);
}

describe("usage shim server", () => {
  const upstream = new FakeUpstream();
  let shim: UsageShim;

  before(async () => {
    await upstream.start();
    shim = await startUsageShim({ upstream: upstream.url, holdMs: 500 });
  });
  after(async () => {
    await shim.close();
    await upstream.stop();
  });

  it("repairs a streamed /v1/messages response using the upstream count_tokens endpoint", async () => {
    upstream.seen.length = 0;
    const response = await fetch(`${shim.url}/v1/messages?beta=true`, { method: "POST", headers: HEADERS, body: JSON.stringify(REQUEST) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await readEvents(response);

    const expectedInput = FakeUpstream.count({ system: REQUEST.system, messages: REQUEST.messages });
    const start = events.find((event) => event.type === "message_start") as { message: { usage: Record<string, number> } };
    assert.equal(start.message.usage.input_tokens, expectedInput);
    const delta = events.find((event) => event.type === "message_delta") as { usage: Record<string, number> };
    const assistant = [{ type: "text", text: "Bonjour le monde, ceci est une réponse." }];
    const expectedOutput = FakeUpstream.count({ messages: [{ content: "x" }, { content: assistant }] }) - FakeUpstream.count({ messages: [{ content: "x" }] });
    assert.deepEqual(delta.usage, { output_tokens: expectedOutput, input_tokens: expectedInput, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    assert.equal(events.at(-1)?.type, "message_stop");

    // La requête amont est intacte (chemin + query, corps, clé) et demandée sans compression.
    const main = upstream.seen.find((seen) => seen.url === "/v1/messages?beta=true");
    assert.ok(main);
    assert.deepEqual(main.body, REQUEST);
    assert.equal(main.headers["x-api-key"], "sk-test");
    assert.equal(main.headers["accept-encoding"], "identity");
    // Les comptages portent l'authentification et ne contiennent que les champs acceptés par count_tokens.
    const counts = upstream.seen.filter((seen) => seen.url === "/v1/messages/count_tokens");
    assert.equal(counts.length, 3, "entrée + témoin + sortie");
    for (const count of counts) {
      assert.equal(count.headers["x-api-key"], "sk-test");
      assert.equal(count.headers["anthropic-beta"], "claude-code-20250219");
    }
    assert.deepEqual(counts[0]?.body, { model: REQUEST.model, system: REQUEST.system, messages: REQUEST.messages, tools: REQUEST.tools });
  });

  it("measures the probe baseline once per model", async () => {
    upstream.seen.length = 0;
    await (await fetch(`${shim.url}/v1/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify(REQUEST) })).text();
    await (await fetch(`${shim.url}/v1/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify(REQUEST) })).text();
    const counts = upstream.seen.filter((seen) => seen.url === "/v1/messages/count_tokens");
    assert.equal(counts.length, 4, "2 × (entrée + sortie), le témoin est en cache");
  });

  it("repairs a non-streamed response too", async () => {
    const response = await fetch(`${shim.url}/v1/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify({ ...REQUEST, stream: false }) });
    const message = (await response.json()) as { usage: Record<string, number>; content: unknown[] };
    assert.equal(message.usage.input_tokens, FakeUpstream.count({ system: REQUEST.system, messages: REQUEST.messages }));
    assert.ok((message.usage.output_tokens ?? 0) > 2);
    assert.equal(message.content.length, 1);
  });

  it("forwards upstream errors and other routes untouched", async () => {
    const error = await fetch(`${shim.url}/v1/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify({ ...REQUEST, model: "unknown-model" }) });
    assert.equal(error.status, 400);
    assert.deepEqual(await error.json(), { type: "error", error: { type: "invalid_request_error", message: "Unknown model" } });

    const models = await fetch(`${shim.url}/v1/models`, { headers: HEADERS });
    assert.equal(models.status, 200);
    assert.equal(models.headers.get("x-upstream"), "yes");
    assert.deepEqual(await models.json(), { data: [{ id: "claude-opus-5-5" }] });

    const missing = await fetch(`${shim.url}/nope`, { headers: HEADERS });
    assert.equal(missing.status, 404);
  });

  it("relays the broken usage unchanged when count_tokens is down, rather than blocking", async () => {
    upstream.countStatus = 500;
    try {
      const response = await fetch(`${shim.url}/v1/messages`, { method: "POST", headers: HEADERS, body: JSON.stringify(REQUEST) });
      const events = await readEvents(response);
      const start = events.find((event) => event.type === "message_start") as { message: { usage: Record<string, number> } };
      assert.equal(start.message.usage.input_tokens, 0);
      const delta = events.find((event) => event.type === "message_delta") as { usage: Record<string, number> };
      assert.equal(delta.usage.output_tokens, 3);
      assert.equal(events.at(-1)?.type, "message_stop");
    } finally {
      upstream.countStatus = 200;
    }
  });

  it("answers the health route locally without touching the upstream", async () => {
    upstream.seen.length = 0;
    const response = await fetch(`${shim.url}${HEALTH_PATH}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, upstream: upstream.url });
    assert.equal(upstream.seen.length, 0);
  });

  it("answers 502 when the upstream is unreachable", async () => {
    const dead = await startUsageShim({ upstream: "http://127.0.0.1:1", holdMs: 100 });
    try {
      const response = await fetch(`${dead.url}/v1/models`);
      assert.equal(response.status, 502);
    } finally {
      await dead.close();
    }
  });
});

describe("usage-shim CLI", () => {
  it("parses its arguments and falls back to ANTHROPIC_BASE_URL for the upstream", () => {
    assert.deepEqual(parseArgs(["--", "claude", "--resume"], { ANTHROPIC_BASE_URL: "https://proxy.example" }), { upstream: "https://proxy.example", holdMs: undefined, trace: false, serve: false, port: DEFAULT_SERVE_PORT, host: "127.0.0.1", command: ["claude", "--resume"] });
    assert.deepEqual(parseArgs(["--upstream", "https://a", "--hold-ms", "250", "--", "x"], {}), { upstream: "https://a", holdMs: 250, trace: false, serve: false, port: DEFAULT_SERVE_PORT, host: "127.0.0.1", command: ["x"] });
    assert.equal(parseArgs(["--trace", "--", "x"], { ANTHROPIC_BASE_URL: "https://a" }).trace, true);
    assert.equal(parseArgs(["--", "x"], { ANTHROPIC_BASE_URL: "https://a", CLAUDE_MASCOTS_USAGE_SHIM_TRACE: "1" }).trace, true);
    assert.throws(() => parseArgs(["--", "x"], {}), /amont manquant/);
    assert.throws(() => parseArgs(["--upstream", "https://a"], {}), /commande manquante/);
    assert.throws(() => parseArgs(["--upstream", "https://a", "--hold-ms", "abc", "--", "x"], {}), /hold-ms/);
    assert.throws(() => parseArgs(["--bizarre", "--", "x"], {}), /argument inconnu/);
  });

  it("parses the permanent relay mode and keeps it on the loopback", () => {
    assert.deepEqual(parseArgs(["--serve", "--upstream", "https://a"], {}), { upstream: "https://a", holdMs: undefined, trace: false, serve: true, port: DEFAULT_SERVE_PORT, host: "127.0.0.1", command: [] });
    assert.equal(parseArgs(["--serve", "--port", "0", "--upstream", "https://a"], {}).port, 0);
    assert.throws(() => parseArgs(["--serve", "--upstream", "https://a", "--", "x"], {}), /s'excluent/);
    assert.throws(() => parseArgs(["--serve", "--port", "70000", "--upstream", "https://a"], {}), /--port/);
    assert.throws(() => parseArgs(["--serve", "--host", "0.0.0.0", "--upstream", "https://a"], {}), /boucle locale/);
  });

  it("serves as a permanent relay: prints its URL, answers the health route, stops on SIGTERM", async () => {
    const upstream = new FakeUpstream();
    await upstream.start();
    const child = spawn(process.execPath, [SHIM_CLI, "--serve", "--port", "0", "--upstream", upstream.url], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          out += chunk;
          if (out.includes("\n")) resolve(out.trim());
        });
        child.once("exit", () => reject(new Error("relais arrêté avant d'annoncer son URL")));
      });
      assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.deepEqual(await (await fetch(url + HEALTH_PATH)).json(), { ok: true, upstream: upstream.url });
      const models = await fetch(`${url}/v1/models`);
      assert.equal(models.headers.get("x-upstream"), "yes");
    } finally {
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill("SIGTERM");
      assert.equal(await exited, 0);
      await upstream.stop();
    }
  });

  it("runs the command with ANTHROPIC_BASE_URL pointing at the shim and returns its exit code", async () => {
    const upstream = new FakeUpstream();
    await upstream.start();
    try {
      const probe = "fetch(process.env.ANTHROPIC_BASE_URL + '/v1/models').then((r) => r.text()).then((t) => { process.stdout.write(t); process.exit(3); })";
      // Lancement asynchrone obligatoire : l'amont factice tourne dans ce processus, un spawnSync le bloquerait.
      const result = await runShimCli(["--upstream", upstream.url, "--", process.execPath, "-e", probe]);
      assert.equal(result.stdout, JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }), result.stderr);
      assert.equal(result.status, 3);
    } finally {
      await upstream.stop();
    }
  });

  it("refuses to start without an upstream", () => {
    const { ANTHROPIC_BASE_URL: _unused, ...env } = process.env;
    const result = spawnSync(process.execPath, [SHIM_CLI, "--", "true"], { encoding: "utf8", env, timeout: 20_000 });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /amont manquant/);
  });
});
