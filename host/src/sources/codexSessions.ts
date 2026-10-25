import { readdir, readFile, readlink } from "node:fs/promises";

/** Un rollout Codex tenu ouvert par un processus vivant. */
export interface OpenRollout {
  path: string;
  pid: number;
}

/** `rollout-2026-10-25T09-03-16-<uuid>.jsonl` ; les archives `.jsonl.zst` et les cibles « (deleted) » sont exclues. */
const ROLLOUT_FILE = /\/rollout-[^/]+\.jsonl$/;
const PID_DIR = /^\d+$/;
const CODEX_PROCESS = /codex/i;

/**
 * Codex n'a pas de registre de sessions : la seule preuve qu'une session vit est le descripteur que son
 * processus garde sur le rollout (mesuré le 2026-10-25 sur `codex exec` et sur le daemon app-server).
 * On ne parcourt que les processus dont le nom contient « codex » : lire les descripteurs de tous les
 * processus coûterait des milliers d'appels système par balayage.
 */
export async function findOpenRollouts(sessionsDir: string, procRoot = "/proc"): Promise<OpenRollout[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    // Pas de /proc (macOS…) : aucune session Codex ne peut être détectée.
    return [];
  }
  const prefix = sessionsDir.endsWith("/") ? sessionsDir : `${sessionsDir}/`;
  const pids = entries
    .filter((entry) => PID_DIR.test(entry))
    .map(Number)
    .toSorted((a, b) => a - b);

  const holders = new Map<string, number>();
  await Promise.all(
    pids.map(async (pid) => {
      if (!(await isCodexProcess(procRoot, pid))) return;
      for (const target of await openFileTargets(procRoot, pid)) {
        if (!target.startsWith(prefix) || !ROLLOUT_FILE.test(target)) continue;
        // Plusieurs processus (parent et enfants) peuvent partager le descripteur : on retient le plus ancien, le parent.
        const known = holders.get(target);
        if (known === undefined || pid < known) holders.set(target, pid);
      }
    }),
  );
  return [...holders]
    .map(([path, pid]) => ({ path, pid }))
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

async function isCodexProcess(procRoot: string, pid: number): Promise<boolean> {
  try {
    return CODEX_PROCESS.test((await readFile(`${procRoot}/${pid}/comm`, "utf8")).trim());
  } catch {
    // Processus terminé entre temps, ou d'un autre utilisateur.
    return false;
  }
}

async function openFileTargets(procRoot: string, pid: number): Promise<string[]> {
  const fdDir = `${procRoot}/${pid}/fd`;
  let fds: string[];
  try {
    fds = await readdir(fdDir);
  } catch {
    return [];
  }
  const targets = await Promise.all(fds.map((fd) => readlink(`${fdDir}/${fd}`).catch(() => null)));
  return targets.filter((target): target is string => target !== null);
}
