import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import {
  type AssembledBlock,
  blocksFromMessageContent,
  buildBaselineCountRequest,
  buildCountRequest,
  buildOutputCountRequest,
  repairMessageJson,
  repairSseStream,
  type TokenCounter,
} from "./repair.ts";

/**
 * Mandataire HTTP local entre Claude Code et un proxy Anthropic qui renseigne mal `usage`.
 * Tout passe tel quel (chemin, méthode, en-têtes, corps, code de réponse) ; seules les réponses de
 * `POST /v1/messages` voient leur `usage` corrigé à l'aide de `/v1/messages/count_tokens` du même amont.
 * Écoute sur la boucle locale uniquement : la clé API ne fait que traverser, elle n'est jamais journalisée.
 */
export interface UsageShimOptions {
  /** Base URL de l'amont (ex. https://ghostcli.cloud). */
  upstream: string;
  host?: string;
  port?: number;
  /** Délai maximal pendant lequel un événement est retenu en attendant un comptage. */
  holdMs?: number;
  log?: (message: string) => void;
  /** Journalise chaque appel `/v1/messages` (modèle, `max_tokens`, statut amont, comptages) — jamais le contenu des messages. */
  trace?: boolean;
  fetchImpl?: typeof fetch;
}

export interface UsageShim {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MESSAGES_PATH = "/v1/messages";
const COUNT_PATH = "/v1/messages/count_tokens";
/** Seule route servie localement (préfixe improbable côté API) ; tout le reste part à l'amont. */
export const HEALTH_PATH = "/_usage-shim/health";
/** En-têtes propres à la connexion entrante : ils ne décrivent pas la requête amont. */
const HOP_BY_HOP = new Set(["host", "connection", "keep-alive", "content-length", "transfer-encoding", "accept-encoding", "upgrade", "proxy-connection"]);
/** En-têtes d'authentification et de version à reprendre pour les appels de comptage. */
const COUNT_HEADERS = ["x-api-key", "authorization", "anthropic-version", "anthropic-beta", "user-agent"];
const DEFAULT_HOLD_MS = 4_000;

export async function startUsageShim(options: UsageShimOptions): Promise<UsageShim> {
  const shim = new ShimHandler(options);
  const server = createServer((request, response) => {
    shim.handle(request, response).catch((error: unknown) => {
      options.log?.(`usage-shim : ${(error as Error).message}`);
      if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "usage-shim: upstream request failed" } }));
    });
  });
  // Les flux SSE durent plusieurs minutes : pas de coupure côté serveur.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${port}`,
    port,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

class ShimHandler {
  private readonly upstream: string;
  private readonly holdMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly trace: boolean;
  /** Tokens d'enrobage du message témoin, par modèle : mesurés une fois, réutilisés pour chaque sortie. */
  private readonly baselines = new Map<string, Promise<number | null>>();

  constructor(options: UsageShimOptions) {
    this.upstream = options.upstream.replace(/\/+$/, "");
    this.holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = options.log ?? (() => {});
    this.trace = options.trace ?? false;
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === "GET" && request.url === HEALTH_PATH) {
      // Permet à un lanceur (cc2) de savoir si un relais permanent tourne et vers quel amont, sans toucher l'amont.
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, upstream: this.upstream }));
      return;
    }
    const body = await readBody(request);
    const controller = new AbortController();
    request.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const headers = forwardedHeaders(request);
    const url = `${this.upstream}${request.url ?? "/"}`;
    const upstreamResponse = await this.fetchImpl(url, {
      method: request.method,
      headers,
      body: body.length > 0 ? new Uint8Array(body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });

    const pathname = new URL(request.url ?? "/", "http://local").pathname;
    const parsedRequest = request.method === "POST" && pathname === MESSAGES_PATH ? parseJsonObject(body) : null;
    if (parsedRequest && this.trace) await this.traceExchange(parsedRequest, upstreamResponse);
    if (parsedRequest && upstreamResponse.ok) {
      await this.relayRepaired(parsedRequest, headers, upstreamResponse, response);
      return;
    }
    await relayUntouched(upstreamResponse, response);
  }

  /** Une ligne par appel : de quoi voir ce que le client demande et ce que l'amont refuse, sans aucun contenu de message. */
  private async traceExchange(parsedRequest: Record<string, unknown>, upstreamResponse: Response): Promise<void> {
    const messages = Array.isArray(parsedRequest.messages) ? parsedRequest.messages.length : 0;
    const summary = `model=${String(parsedRequest.model)} max_tokens=${String(parsedRequest.max_tokens)} stream=${String(parsedRequest.stream)} messages=${messages} → ${upstreamResponse.status}`;
    if (upstreamResponse.ok) {
      this.log(`usage-shim : ${summary}`);
      return;
    }
    // Le corps d'une erreur est court et ne contient pas la conversation : on en garde un extrait.
    const excerpt = (await upstreamResponse.clone().text().catch(() => "")).slice(0, 300).replace(/\s+/g, " ");
    this.log(`usage-shim : ${summary} ${excerpt}`);
  }

  private async relayRepaired(
    parsedRequest: Record<string, unknown>,
    headers: Record<string, string>,
    upstreamResponse: Response,
    response: ServerResponse,
  ): Promise<void> {
    const counter = this.counterFor(headers);
    const inputCount = counter(buildCountRequest(parsedRequest));
    const countOutput = (blocks: readonly AssembledBlock[]) => this.countOutput(counter, parsedRequest.model, blocks);
    const contentType = upstreamResponse.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream") && upstreamResponse.body) {
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      const source = Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream<Uint8Array>).setEncoding("utf8");
      for await (const chunk of repairSseStream(source as AsyncIterable<string>, { inputCount, countOutput, holdMs: this.holdMs })) {
        if (!response.write(chunk)) await new Promise<void>((resolve) => response.once("drain", resolve));
      }
      response.end();
      return;
    }

    const text = await upstreamResponse.text();
    const message = contentType.includes("application/json") ? parseJsonObject(text) : null;
    if (!message || message.type !== "message") {
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
      response.end(text);
      return;
    }
    const [input, output] = await Promise.all([inputCount, countOutput(blocksFromMessageContent(message.content))]);
    response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
    response.end(JSON.stringify(repairMessageJson(message, { input, output })));
  }

  private counterFor(headers: Record<string, string>): TokenCounter {
    const countHeaders: Record<string, string> = { "content-type": "application/json" };
    for (const name of COUNT_HEADERS) {
      if (headers[name]) countHeaders[name] = headers[name];
    }
    return async (body) => {
      try {
        const reply = await this.fetchImpl(`${this.upstream}${COUNT_PATH}`, { method: "POST", headers: countHeaders, body: JSON.stringify(body) });
        if (!reply.ok) {
          this.log(`usage-shim : count_tokens a répondu ${reply.status}`);
          return null;
        }
        const parsed = (await reply.json()) as { input_tokens?: unknown };
        const counted = typeof parsed.input_tokens === "number" && Number.isFinite(parsed.input_tokens) ? parsed.input_tokens : null;
        if (this.trace) this.log(`usage-shim : count_tokens(${Array.isArray(body.messages) ? body.messages.length : 0} messages) → ${String(counted)}`);
        return counted;
      } catch (error) {
        this.log(`usage-shim : count_tokens injoignable (${(error as Error).message})`);
        return null;
      }
    };
  }

  private async countOutput(counter: TokenCounter, model: unknown, blocks: readonly AssembledBlock[]): Promise<number | null> {
    const key = typeof model === "string" ? model : "";
    let baseline = this.baselines.get(key);
    if (!baseline) {
      baseline = counter(buildBaselineCountRequest(model));
      this.baselines.set(key, baseline);
      // Un échec ne doit pas être mémorisé : on réessaiera au prochain message.
      baseline.then((value) => value === null && this.baselines.delete(key)).catch(() => this.baselines.delete(key));
    }
    const [withMessage, probeOnly] = await Promise.all([counter(buildOutputCountRequest(model, blocks)), baseline]);
    if (withMessage === null || probeOnly === null) return null;
    return Math.max(0, withMessage - probeOnly);
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function forwardedHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  // Le flux doit arriver en clair pour être lu : pas de compression côté amont.
  headers["accept-encoding"] = "identity";
  return headers;
}

/** En-têtes de la réponse amont, moins ceux que la réécriture invalide (longueur, encodage, connexion). */
function responseHeaders(upstreamResponse: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, name) => {
    if (name === "content-length" || name === "content-encoding" || name === "transfer-encoding" || name === "connection") return;
    headers[name] = value;
  });
  return headers;
}

async function relayUntouched(upstreamResponse: Response, response: ServerResponse): Promise<void> {
  response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse));
  if (!upstreamResponse.body) {
    response.end();
    return;
  }
  const source = Readable.fromWeb(upstreamResponse.body as import("node:stream/web").ReadableStream<Uint8Array>);
  await new Promise<void>((resolve, reject) => {
    source.once("error", reject);
    response.once("close", resolve);
    source.pipe(response).once("finish", resolve);
  });
}

function parseJsonObject(input: Buffer | string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(typeof input === "string" ? input : input.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
