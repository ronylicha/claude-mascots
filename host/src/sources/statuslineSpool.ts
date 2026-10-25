import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { StatuslineSnapshot } from "../types.ts";
import { parseRateLimitWindow } from "./quota.ts";

const SPOOL_FILE = /^[0-9a-f-]{36}\.json$/;
/** Temporaires du tap (`mktemp .tmp.XXXXXX`) laissés par un processus tué avant son `mv`. */
const ORPHAN_TEMP_FILE = /^\.tmp\.[A-Za-z0-9]{6}$/;
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60_000;

/** Sous-ensemble du JSON envoyé par Claude Code à la barre d'état ; tout est optionnel et vérifié. */
interface StatuslinePayload {
  session_id?: unknown;
  transcript_path?: unknown;
  model?: { display_name?: unknown };
  cost?: { total_cost_usd?: unknown };
  context_window?: { used_percentage?: unknown; context_window_size?: unknown };
  rate_limits?: { five_hour?: unknown; seven_day?: unknown };
}

const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Convertit une entrée JSON de la barre d'état (format Claude Code) en snapshot typé. */
export function parseStatuslinePayload(raw: unknown, observedAt: number): StatuslineSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as StatuslinePayload;
  const sessionId = asString(payload.session_id);
  if (sessionId === null) return null;
  return {
    sessionId,
    transcriptPath: asString(payload.transcript_path),
    modelName: asString(payload.model?.display_name),
    costUsd: asNumber(payload.cost?.total_cost_usd),
    contextUsedPercent: asNumber(payload.context_window?.used_percentage),
    contextWindowSize: asNumber(payload.context_window?.context_window_size),
    quota: {
      fiveHour: parseRateLimitWindow(payload.rate_limits?.five_hour),
      sevenDay: parseRateLimitWindow(payload.rate_limits?.seven_day),
    },
    observedAt,
  };
}

/** Lit les snapshots déposés par `tap/statusline-tap.sh` (un fichier par session). */
export async function readStatuslineSpool(spoolDir: string): Promise<Map<string, StatuslineSnapshot>> {
  const snapshots = new Map<string, StatuslineSnapshot>();
  let files: string[];
  try {
    files = await readdir(spoolDir);
  } catch {
    return snapshots;
  }
  await Promise.all(
    files
      .filter((file) => SPOOL_FILE.test(file))
      .map(async (file) => {
        const path = join(spoolDir, file);
        try {
          const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
          const snapshot = parseStatuslinePayload(JSON.parse(content), info.mtimeMs);
          if (snapshot) snapshots.set(snapshot.sessionId, snapshot);
        } catch {
          // Écriture atomique côté tap (mv), un échec ici ne peut être qu'une suppression concurrente.
        }
      }),
  );
  return snapshots;
}

/** Une copie par session jamais supprimée finirait par encombrer le dossier : on purge les anciennes. */
export async function pruneStaleSnapshots(spoolDir: string, maxAgeMs: number, now: number): Promise<number> {
  let files: string[];
  try {
    files = await readdir(spoolDir);
  } catch {
    return 0;
  }
  const removed = await Promise.all(
    files
      .filter((file) => SPOOL_FILE.test(file) || ORPHAN_TEMP_FILE.test(file))
      .map(async (file) => {
        const path = join(spoolDir, file);
        const retention = ORPHAN_TEMP_FILE.test(file) ? ORPHAN_TEMP_MAX_AGE_MS : maxAgeMs;
        try {
          if (now - (await stat(path)).mtimeMs <= retention) return false;
          await rm(path, { force: true });
          return true;
        } catch {
          return false;
        }
      }),
  );
  return removed.filter(Boolean).length;
}
