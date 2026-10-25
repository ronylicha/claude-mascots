#!/usr/bin/env node
// Correcteur d'usage local : ANTHROPIC_BASE_URL du client pointe sur lui, il relaie vers l'amont en
// réparant les compteurs de tokens. Deux modes :
//
//   usage-shim.ts [--upstream URL] [--hold-ms N] [--trace] -- commande [arguments...]
//       lance la commande (Claude Code) avec ANTHROPIC_BASE_URL réécrit ; le processus vit exactement
//       le temps de la commande et rend son code de sortie.
//   usage-shim.ts --serve [--port N] [--host IP] [--upstream URL] [--hold-ms N] [--trace]
//       relais permanent (service systemd) : écoute jusqu'à SIGINT/SIGTERM, affiche l'URL sur stdout.
//
// Sans --upstream, ANTHROPIC_BASE_URL de l'environnement est l'amont.
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { startUsageShim } from "../host/src/usageShim/server.ts";

export const DEFAULT_SERVE_PORT = 4748;
const LOOPBACK = "127.0.0.1";

export interface CliOptions {
  upstream: string;
  holdMs: number | undefined;
  /** `--trace` ou `CLAUDE_MASCOTS_USAGE_SHIM_TRACE=1` : une ligne par appel API sur stderr (sans contenu). */
  trace: boolean;
  /** Mode relais permanent : pas de commande, écoute sur `port`. */
  serve: boolean;
  port: number;
  host: string;
  command: string[];
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  let upstream = env.ANTHROPIC_BASE_URL ?? "";
  let holdMs: number | undefined;
  let trace = env.CLAUDE_MASCOTS_USAGE_SHIM_TRACE === "1";
  let serve = false;
  let port = DEFAULT_SERVE_PORT;
  let host = LOOPBACK;
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (argument === "--") {
      command.push(...argv.slice(index + 1));
      break;
    }
    if (argument === "--upstream") upstream = argv[++index] ?? "";
    else if (argument === "--hold-ms") holdMs = Number(argv[++index]);
    else if (argument === "--trace") trace = true;
    else if (argument === "--serve") serve = true;
    else if (argument === "--port") port = Number(argv[++index]);
    else if (argument === "--host") host = argv[++index] ?? "";
    else throw new Error(`argument inconnu : ${argument}`);
  }
  if (!/^https?:\/\//.test(upstream)) throw new Error("amont manquant : --upstream URL ou ANTHROPIC_BASE_URL");
  if (serve && command.length > 0) throw new Error("--serve et une commande après -- s'excluent");
  if (!serve && command.length === 0) throw new Error("commande manquante après -- (ou --serve pour un relais permanent)");
  if (holdMs !== undefined && !(Number.isFinite(holdMs) && holdMs > 0)) throw new Error("--hold-ms attend un nombre de millisecondes > 0");
  if (!(Number.isInteger(port) && port >= 0 && port <= 65_535)) throw new Error("--port attend un entier entre 0 et 65535");
  // Un relais qui écoute ailleurs que sur la boucle locale exposerait les clés API de ses clients.
  if (!/^(127\.\d+\.\d+\.\d+|::1|localhost)$/.test(host)) throw new Error("--host doit rester sur la boucle locale (127.x.x.x, ::1 ou localhost)");
  return { upstream, holdMs, trace, serve, port, host, command };
}

async function main(): Promise<never> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`usage-shim : ${(error as Error).message}`);
    process.exit(2);
  }

  const log = (message: string): void => console.error(`[usage-shim] ${message}`);
  const code = options.serve ? await serve(options, log) : await runCommand(options, log);
  process.exit(code);
}

/** Relais permanent : l'URL est écrite sur stdout (une ligne) pour les scripts, puis on attend un signal. */
async function serve(options: CliOptions, log: (message: string) => void): Promise<number> {
  const shim = await startUsageShim({ upstream: options.upstream, host: options.host, port: options.port, holdMs: options.holdMs, trace: options.trace, log });
  process.stdout.write(`${shim.url}\n`);
  log(`relais permanent sur ${shim.url} → ${options.upstream}`);
  const signal = await new Promise<NodeJS.Signals>((resolve) => {
    process.once("SIGINT", () => resolve("SIGINT"));
    process.once("SIGTERM", () => resolve("SIGTERM"));
  });
  log(`arrêt (${signal})`);
  await shim.close();
  return 0;
}

async function runCommand(options: CliOptions, log: (message: string) => void): Promise<number> {
  const shim = await startUsageShim({ upstream: options.upstream, holdMs: options.holdMs, trace: options.trace, log });
  const [executable, ...args] = options.command as [string, ...string[]];
  const child = spawn(executable, args, {
    stdio: "inherit",
    env: { ...process.env, ANTHROPIC_BASE_URL: shim.url, CLAUDE_MASCOTS_USAGE_SHIM_UPSTREAM: options.upstream },
  });

  // Ctrl-C arrive au groupe entier : l'enfant le gère lui-même, le correcteur doit lui survivre.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGHUP", () => child.kill("SIGHUP"));

  const code = await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      log(`impossible de lancer ${executable} : ${error.message}`);
      resolve(127);
    });
    child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 + signalNumber(signal) : 1)));
  });
  await shim.close();
  return code;
}

/** Convention shell : un processus tué par un signal sort avec 128 + numéro du signal. */
function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 0;
}

// Exécuté directement (pas importé par un test) : on lance la commande ou le relais.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
