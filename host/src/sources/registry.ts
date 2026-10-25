import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RegistryEntry } from "../types.ts";

// Les fichiers `<pid>.<hash>.key` voisins sont des secrets de messagerie inter-sessions :
// on ne lit que `<pid>.json`.
const REGISTRY_FILE = /^\d+\.json$/;

/** Valide une entrée du registre ; renvoie null si le format a changé ou si le fichier est partiel. */
export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.pid !== "number" || !Number.isInteger(entry.pid) || entry.pid <= 0) return null;
  if (typeof entry.sessionId !== "string") return null;
  return {
    pid: entry.pid,
    sessionId: entry.sessionId,
    cwd: typeof entry.cwd === "string" ? entry.cwd : "",
    name: typeof entry.name === "string" ? entry.name : entry.sessionId.slice(0, 8),
    status: typeof entry.status === "string" ? entry.status : "idle",
    version: typeof entry.version === "string" ? entry.version : "?",
    startedAt: typeof entry.startedAt === "number" ? entry.startedAt : Date.now(),
    statusUpdatedAt: typeof entry.statusUpdatedAt === "number" ? entry.statusUpdatedAt : 0,
    procStart: typeof entry.procStart === "string" ? entry.procStart : null,
  };
}

/** Champ 22 de /proc/<pid>/stat (instant de démarrage) ; le nom du processus peut contenir espaces et parenthèses. */
export function parseProcStartTime(statLine: string): string | null {
  const afterName = statLine.slice(statLine.lastIndexOf(")") + 2).split(" ");
  // afterName[0] est le champ 3 (état) : le champ 22 est donc à l'index 19.
  return afterName[19] ?? null;
}

/**
 * Un fichier de registre survit à un crash et le PID peut être réattribué à un autre processus.
 * Sous Linux, Claude Code enregistre l'instant de démarrage (`procStart`) : on exige qu'il corresponde.
 */
export async function isSessionProcessAlive(entry: RegistryEntry): Promise<boolean> {
  try {
    process.kill(entry.pid, 0);
  } catch (error) {
    // EPERM = le processus existe mais appartient à un autre utilisateur.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (entry.procStart === null) return true;
  try {
    return parseProcStartTime(await readFile(`/proc/${entry.pid}/stat`, "utf8")) === entry.procStart;
  } catch {
    // Pas de /proc (macOS…) : on s'en tient au test de signal.
    return true;
  }
}

export async function readActiveSessions(
  registryDir: string,
  isAlive: (entry: RegistryEntry) => Promise<boolean> | boolean = isSessionProcessAlive,
): Promise<RegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries = await Promise.all(
    files.filter((file) => REGISTRY_FILE.test(file)).map((file) => readEntry(join(registryDir, file))),
  );
  const candidates = entries.filter((entry) => entry !== null) as RegistryEntry[];
  const alive = await Promise.all(candidates.map((entry) => isAlive(entry)));
  return candidates.filter((_, index) => alive[index]);
}

async function readEntry(path: string): Promise<RegistryEntry | null> {
  try {
    return parseRegistryEntry(JSON.parse(await readFile(path, "utf8")));
  } catch {
    // Fichier en cours de réécriture par Claude Code : il sera relu au prochain tick.
    return null;
  }
}
