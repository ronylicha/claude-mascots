import { readFile } from "node:fs/promises";
import type { AccountQuota, QuotaWindow, StatuslineSnapshot } from "../types.ts";

/** Format natif de Claude Code (`rate_limits`) : pourcentage + reset en epoch SECONDES. */
export function parseRateLimitWindow(raw: unknown): QuotaWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const window = raw as Record<string, unknown>;
  if (typeof window.used_percentage !== "number") return null;
  return {
    usedPercent: clampPercent(window.used_percentage),
    resetsAt: typeof window.resets_at === "number" ? window.resets_at * 1000 : null,
  };
}

/** Format du cache de la barre d'état (`/api/oauth/usage`) : utilization + reset en ISO 8601. */
export function parseCachedUsageWindow(raw: unknown): QuotaWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const window = raw as Record<string, unknown>;
  if (typeof window.utilization !== "number") return null;
  const resetsAt = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return {
    usedPercent: clampPercent(window.utilization),
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export async function readQuotaCache(path: string): Promise<AccountQuota | null> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as { data?: Record<string, unknown>; timestamp?: number };
    if (!cached.data) return null;
    return {
      fiveHour: parseCachedUsageWindow(cached.data.five_hour),
      sevenDay: parseCachedUsageWindow(cached.data.seven_day),
      source: "cache",
      observedAt: typeof cached.timestamp === "number" ? cached.timestamp : null,
    };
  } catch {
    return null;
  }
}

export function noQuota(): AccountQuota {
  return { fiveHour: null, sevenDay: null, source: "none", observedAt: null };
}

/**
 * Le quota appartient au compte, pas à la session : toutes les sessions d'un même fournisseur voient la
 * même valeur. On garde l'observation la plus récente qui ne soit pas périmée, toutes sources confondues.
 */
export function pickFreshestQuota(candidates: AccountQuota[], now: number, staleAfterMs: number): AccountQuota {
  const best = candidates
    .filter((candidate) => candidate.observedAt !== null && now - candidate.observedAt < staleAfterMs)
    .reduce<AccountQuota | null>((acc, candidate) => (acc === null || (candidate.observedAt ?? 0) > (acc.observedAt ?? 0) ? candidate : acc), null);
  return best ? expireElapsedWindows(best, now) : noQuota();
}

/** Quota du compte Anthropic : copies de la barre d'état (une par session) puis cache de la barre d'état d'origine. */
export function resolveAccountQuota(
  snapshots: StatuslineSnapshot[],
  cache: AccountQuota | null,
  now: number,
  staleAfterMs: number,
): AccountQuota {
  const freshest = snapshots
    .filter((snapshot) => snapshot.quota.fiveHour !== null || snapshot.quota.sevenDay !== null)
    .reduce<StatuslineSnapshot | null>((best, snapshot) => (best === null || snapshot.observedAt > best.observedAt ? snapshot : best), null);

  const candidates: AccountQuota[] = [];
  if (freshest) {
    candidates.push({ ...freshest.quota, source: "statusline", observedAt: freshest.observedAt });
  }
  if (cache) candidates.push(cache);
  return pickFreshestQuota(candidates, now, staleAfterMs);
}

/** Une fenêtre dont la date de reset est passée est repartie de zéro, même si l'observation date d'avant. */
function expireElapsedWindows(quota: AccountQuota, now: number): AccountQuota {
  const reset = (window: QuotaWindow | null): QuotaWindow | null =>
    window && window.resetsAt !== null && window.resetsAt <= now ? { usedPercent: 0, resetsAt: null } : window;
  return { ...quota, fiveHour: reset(quota.fiveHour), sevenDay: reset(quota.sevenDay) };
}
