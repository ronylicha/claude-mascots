import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { DashboardState } from "../types.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

/** Sert le tableau de bord, `/api/state` (instantané JSON) et `/events` (flux SSE). */
export class DashboardServer {
  private readonly clients = new Set<ServerResponse>();
  private latest: DashboardState | null = null;
  private readonly server: Server;
  private readonly webRoot: string;
  /** Fichiers servis hors du dossier web (chemin URL → chemin disque), liste fermée. */
  private readonly aliases: Readonly<Record<string, string>>;

  constructor(webRoot: string, aliases: Readonly<Record<string, string>> = {}) {
    this.webRoot = webRoot;
    this.aliases = aliases;
    this.server = createServer((request, response) => {
      // Une requête mal formée ne doit jamais faire tomber le démon (rejet non géré = arrêt de Node).
      this.route(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => resolve());
    });
  }

  close(): Promise<void> {
    for (const client of this.clients) client.end();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  publish(state: DashboardState): void {
    this.latest = state;
    const message = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of this.clients) {
      // Onglet gelé qui ne lit plus : on le déconnecte plutôt que d'accumuler en mémoire (EventSource se reconnectera).
      if (client.writableNeedDrain) {
        client.destroy();
        this.clients.delete(client);
        continue;
      }
      client.write(message);
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Anti DNS-rebinding : une page tierce qui résoudrait vers 127.0.0.1 n'aurait pas cet en-tête Host.
    if (!isLoopbackHost(request.headers.host)) {
      response.writeHead(421).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      // Ex. `GET //` : `new URL("//", base)` lève une exception.
      response.writeHead(400).end();
      return;
    }
    if (url.pathname === "/events") return this.openEventStream(response);
    if (url.pathname === "/api/state") {
      response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "application/json" }).end(JSON.stringify(this.latest));
      return;
    }
    await this.serveStatic(url.pathname, response);
  }

  private openEventStream(response: ServerResponse): void {
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream", Connection: "keep-alive" });
    if (this.latest) response.write(`data: ${JSON.stringify(this.latest)}\n\n`);
    this.clients.add(response);
    response.on("close", () => this.clients.delete(response));
  }

  private resolveStaticPath(pathname: string): string | null {
    const alias = this.aliases[pathname];
    if (alias) return alias;
    const relative = pathname === "/" ? "index.html" : pathname.slice(1);
    const filePath = normalize(join(this.webRoot, relative));
    // Empêche `/../` de sortir du dossier web.
    return filePath.startsWith(normalize(this.webRoot + sep)) ? filePath : null;
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const filePath = this.resolveStaticPath(pathname);
    if (!filePath || !CONTENT_TYPES[extname(filePath)]) {
      response.writeHead(404).end();
      return;
    }
    const isFile = await stat(filePath).then((info) => info.isFile(), () => false);
    if (!isFile) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": CONTENT_TYPES[extname(filePath)] });
    // pipeline propage les erreurs (fichier supprimé entre stat et lecture) au lieu d'un `error` non géré.
    await pipeline(createReadStream(filePath), response);
  }
}

export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
