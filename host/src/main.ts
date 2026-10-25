import { config } from "./config.ts";
import { Collector } from "./domain/collector.ts";
import { pruneStaleSnapshots } from "./sources/statuslineSpool.ts";
import { buildDeviceFrame, encodeDeviceFrame } from "./transport/deviceFrame.ts";
import { DashboardServer } from "./transport/httpServer.ts";
import { SerialBridge } from "./transport/serialBridge.ts";

const log = (message: string): void => {
  console.log(`[${new Date().toLocaleTimeString("fr-FR")}] ${message}`);
};

const collector = new Collector({
  registryDir: config.paths.sessionRegistry,
  projectsDir: config.paths.projects,
  spoolDir: config.paths.statuslineSpool,
  quotaCacheFile: config.paths.quotaCacheFile,
  codexSessionsDir: config.paths.codexSessions,
  procRoot: config.paths.proc,
  codexScanIntervalMs: config.timing.codexScanIntervalMs,
  historyMinutes: config.timing.historyMinutes,
  sleepAfterMs: config.timing.sleepAfterMs,
  quotaStaleMs: config.timing.quotaStaleMs,
  log,
});
const server = new DashboardServer(config.paths.web, { "/sprites.json": config.paths.sprites });
const serial = new SerialBridge({ ...config.serial, log });

const SHUTDOWN_TIMEOUT_MS = 2_000;
let ticking = false;
let lastSessionCount = -1;

async function tick(): Promise<void> {
  // Un tick lent (gros journal à rattraper) ne doit pas en empiler d'autres.
  if (ticking) return;
  ticking = true;
  try {
    const state = await collector.collect(Date.now(), serial.status);
    server.publish(state);
    serial.send(encodeDeviceFrame(buildDeviceFrame(state, config.serial.maxSessionsPerFrame)));
    if (state.sessions.length !== lastSessionCount) {
      lastSessionCount = state.sessions.length;
      const codex = state.sessions.filter((session) => session.provider === "codex").length;
      log(`${state.sessions.length - codex} session(s) Claude Code et ${codex} session(s) Codex · quota Claude ${state.quotas.claude.source}, Codex ${state.quotas.codex.source}`);
    }
  } catch (error) {
    log(`collecte en échec : ${(error as Error).stack ?? error}`);
  } finally {
    ticking = false;
  }
}

async function pruneSpool(): Promise<void> {
  const removed = await pruneStaleSnapshots(config.paths.statuslineSpool, config.timing.spoolRetentionMs, Date.now());
  if (removed > 0) log(`${removed} ancienne(s) copie(s) de barre d'état purgée(s)`);
}

async function shutdown(): Promise<void> {
  log("arrêt…");
  clearInterval(timer);
  clearInterval(pruneTimer);
  serial.stop();
  // Des clients SSE peuvent retarder la fermeture : l'arrêt ne doit jamais dépasser quelques secondes.
  await Promise.race([server.close(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
  process.exit(0);
}

await server.listen(config.http.port, config.http.host);
log(`tableau de bord : http://${config.http.host}:${config.http.port}`);
serial.start();
await tick();
const timer = setInterval(() => void tick(), config.timing.tickMs);
await pruneSpool();
const pruneTimer = setInterval(() => void pruneSpool(), 60 * 60_000);
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
