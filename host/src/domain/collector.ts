import { basename } from "node:path";
import { CodexRolloutTracker, type CodexRolloutSnapshot } from "../sources/codexRollout.ts";
import { findOpenRollouts, type OpenRollout } from "../sources/codexSessions.ts";
import { pickFreshestQuota, readQuotaCache, resolveAccountQuota } from "../sources/quota.ts";
import { readActiveSessions } from "../sources/registry.ts";
import { readStatuslineSpool } from "../sources/statuslineSpool.ts";
import { displayToolName, emptyToolCounts, findTranscriptPath, TranscriptTracker } from "../sources/transcript.ts";
import type { AccountQuota, DashboardState, Provider, RegistryEntry, SessionView, StatuslineSnapshot, TranscriptStats } from "../types.ts";
import { avatarFor } from "./avatar.ts";
import { deriveActivity, deriveMoodState, MOOD_THRESHOLDS } from "./behavior.ts";

export interface CollectorOptions {
  registryDir: string;
  projectsDir: string;
  spoolDir: string;
  quotaCacheFile: string;
  /** Dossier `~/.codex/sessions` ; les rollouts qu'un processus Codex tient ouverts sont les sessions vivantes. */
  codexSessionsDir: string;
  /** Racine du système de fichiers des processus (`/proc`), remplaçable dans les tests. */
  procRoot?: string;
  codexScanIntervalMs: number;
  historyMinutes: number;
  sleepAfterMs: number;
  quotaStaleMs: number;
  /** Erreurs non bloquantes (journal illisible…) : signalées plutôt qu'avalées. */
  log?: (message: string) => void;
}

/** Ce qu'une source sait d'une session avant toute dérivation (activité, humeur) : commun aux deux fournisseurs. */
interface SessionFacts {
  provider: Provider;
  sessionId: string;
  pid: number;
  name: string;
  cwd: string;
  version: string;
  status: string;
  startedAt: number;
  statusUpdatedAt: number;
  model: string | null;
  costUsd: number | null;
  contextPercent: number | null;
  contextWindowSize: number | null;
}

interface ProviderCollection {
  sessions: SessionView[];
  quota: AccountQuota;
}

/** Moyenne glissante sur les dernières minutes : un tour isolé ne fait pas exploser l'affichage. */
const RATE_WINDOW_MINUTES = 5;

export class Collector {
  private readonly claudeTrackers = new Map<string, TranscriptTracker>();
  private readonly codexTrackers = new Map<string, CodexRolloutTracker>();
  private openRollouts: OpenRollout[] = [];
  private lastCodexScanAt = Number.NEGATIVE_INFINITY;

  private readonly options: CollectorOptions;

  constructor(options: CollectorOptions) {
    this.options = options;
  }

  async collect(now: number, device: DashboardState["device"]): Promise<DashboardState> {
    const [claude, codex] = await Promise.all([this.collectClaude(now), this.collectCodex(now)]);
    const ordered = [...claude.sessions, ...codex.sessions].toSorted((a, b) => a.startedAt - b.startedAt);

    return {
      generatedAt: now,
      quotas: { claude: claude.quota, codex: codex.quota },
      sessions: ordered,
      totals: {
        costUsd: ordered.reduce((sum, session) => sum + (session.costUsd ?? 0), 0),
        tokensPerMinute: ordered.reduce((sum, session) => sum + session.tokensPerMinute, 0),
        sessions: ordered.length,
        working: ordered.filter((session) => session.activity === "working").length,
      },
      device,
      moodThresholds: MOOD_THRESHOLDS,
    };
  }

  // -------------------------------------------------------------------------------------------------
  // Claude Code : registre `sessions/<pid>.json`, journal `projects/<slug>/<id>.jsonl`, copies de barre d'état.

  private async collectClaude(now: number): Promise<ProviderCollection> {
    const [registry, spool, quotaCache] = await Promise.all([
      readActiveSessions(this.options.registryDir),
      readStatuslineSpool(this.options.spoolDir),
      readQuotaCache(this.options.quotaCacheFile),
    ]);
    forgetMissing(this.claudeTrackers, new Set(registry.map((entry) => entry.sessionId)));
    const quota = resolveAccountQuota([...spool.values()], quotaCache, now, this.options.quotaStaleMs);

    const sessions = await Promise.all(
      registry.map(async (entry) => {
        const snapshot = spool.get(entry.sessionId) ?? null;
        const stats = await this.readTranscript(entry.sessionId, snapshot, now);
        return this.buildView(claudeFacts(entry, snapshot, stats), stats, quota, now);
      }),
    );
    return { sessions, quota };
  }

  private async readTranscript(sessionId: string, snapshot: StatuslineSnapshot | null, now: number): Promise<TranscriptStats | null> {
    let tracker = this.claudeTrackers.get(sessionId);
    if (!tracker) {
      const path = snapshot?.transcriptPath ?? (await findTranscriptPath(this.options.projectsDir, sessionId));
      // Session neuve sans premier message : le journal n'existe pas encore, on réessaiera.
      if (!path) return null;
      tracker = new TranscriptTracker(path);
      this.claudeTrackers.set(sessionId, tracker);
    }
    try {
      await tracker.refresh();
    } catch (error) {
      this.reportUnreadable(tracker.path, error);
      this.claudeTrackers.delete(sessionId);
      return null;
    }
    return tracker.snapshot(now, this.options.historyMinutes);
  }

  // -------------------------------------------------------------------------------------------------
  // Codex : pas de registre ; un rollout tenu ouvert par un processus `codex` est une session vivante.

  private async collectCodex(now: number): Promise<ProviderCollection> {
    if (now - this.lastCodexScanAt >= this.options.codexScanIntervalMs) {
      this.openRollouts = await findOpenRollouts(this.options.codexSessionsDir, this.options.procRoot);
      this.lastCodexScanAt = now;
    }
    forgetMissing(this.codexTrackers, new Set(this.openRollouts.map((rollout) => rollout.path)));

    const readings = await Promise.all(this.openRollouts.map((rollout) => this.readRollout(rollout, now)));
    const live = readings.filter((reading): reading is RolloutReading => reading !== null);

    const quota = pickFreshestQuota(
      live.flatMap(({ snapshot }) => (snapshot.quota ? [{ ...snapshot.quota, source: "rollout" as const }] : [])),
      now,
      this.options.quotaStaleMs,
    );
    // Les fils de sous-agents vivent dans le même processus que leur parent : une seule mascotte par fil racine.
    const sessions = live
      .filter(({ snapshot }) => snapshot.meta.sessionId !== null && !snapshot.meta.isSubagent)
      .map(({ rollout, snapshot }) => this.buildView(codexFacts(rollout, snapshot), snapshot.stats, quota, now));
    return { sessions, quota };
  }

  private async readRollout(rollout: OpenRollout, now: number): Promise<RolloutReading | null> {
    let tracker = this.codexTrackers.get(rollout.path);
    if (!tracker) {
      tracker = new CodexRolloutTracker(rollout.path, now);
      this.codexTrackers.set(rollout.path, tracker);
    }
    try {
      await tracker.refresh();
    } catch (error) {
      this.reportUnreadable(rollout.path, error);
      this.codexTrackers.delete(rollout.path);
      return null;
    }
    return { rollout, snapshot: tracker.snapshot(now, this.options.historyMinutes) };
  }

  // -------------------------------------------------------------------------------------------------

  private buildView(facts: SessionFacts, stats: TranscriptStats | null, quota: AccountQuota, now: number): SessionView {
    const lastActivityAt = stats?.lastActivityAt ?? null;
    const activity = deriveActivity({
      registryStatus: facts.status,
      statusUpdatedAt: facts.statusUpdatedAt,
      lastActivityAt,
      now,
      sleepAfterMs: this.options.sleepAfterMs,
    });
    // Le contexte et le coût dérivent du même `usage` que le journal : si l'amont n'a pas transmis les tokens
    // d'entrée, un « 0 % » ou un coût ne sont pas des mesures, on les tait.
    const usageReliable = stats?.usageReliable ?? true;
    const contextPercent = usageReliable ? facts.contextPercent : null;
    const history = stats?.perMinute ?? Array.from({ length: this.options.historyMinutes }, () => 0);
    const recent = history.slice(-RATE_WINDOW_MINUTES);
    const { mood, cause } = deriveMoodState({ activity, contextPercent, quota });

    return {
      provider: facts.provider,
      sessionId: facts.sessionId,
      pid: facts.pid,
      name: facts.name,
      project: basename(facts.cwd) || facts.cwd,
      cwd: facts.cwd,
      version: facts.version,
      model: facts.model,
      status: facts.status,
      activity,
      mood,
      moodCause: cause,
      // L'outil n'a de sens que pendant le travail ; au repos le personnage pose ses accessoires.
      tool: activity === "working" ? (stats?.lastToolKind ?? "think") : null,
      toolName: activity === "working" && stats?.lastTool ? displayToolName(stats.lastTool) : null,
      costUsd: usageReliable ? facts.costUsd : null,
      contextPercent,
      contextWindowSize: facts.contextWindowSize,
      tokens: stats?.totals ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageReliable,
      tokensPerMinute: Math.round(recent.reduce((sum, value) => sum + value, 0) / RATE_WINDOW_MINUTES),
      history,
      turns: stats?.assistantTurns ?? 0,
      toolCounts: stats?.toolCounts ?? emptyToolCounts(),
      recentTools: stats?.recentTools ?? [],
      avatar: avatarFor(facts.sessionId),
      startedAt: facts.startedAt,
      lastActivityAt,
    };
  }

  private reportUnreadable(path: string, error: unknown): void {
    // ENOENT = journal supprimé ou déplacé : il sera recherché au prochain tick. Le reste est anormal.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      this.options.log?.(`journal ${path} illisible : ${(error as Error).message}`);
    }
  }
}

interface RolloutReading {
  rollout: OpenRollout;
  snapshot: CodexRolloutSnapshot;
}

function claudeFacts(entry: RegistryEntry, snapshot: StatuslineSnapshot | null, stats: TranscriptStats | null): SessionFacts {
  return {
    provider: "claude",
    sessionId: entry.sessionId,
    pid: entry.pid,
    name: entry.name,
    cwd: entry.cwd,
    version: entry.version,
    status: entry.status,
    startedAt: entry.startedAt,
    statusUpdatedAt: entry.statusUpdatedAt,
    model: snapshot?.modelName ?? stats?.model ?? null,
    costUsd: snapshot?.costUsd ?? null,
    contextPercent: snapshot?.contextUsedPercent ?? null,
    contextWindowSize: snapshot?.contextWindowSize ?? null,
  };
}

function codexFacts(rollout: OpenRollout, snapshot: CodexRolloutSnapshot): SessionFacts {
  const { meta } = snapshot;
  const sessionId = meta.sessionId ?? "";
  const cwd = meta.cwd ?? "";
  return {
    provider: "codex",
    sessionId,
    pid: rollout.pid,
    // Codex ne nomme pas ses fils : dossier + fin de l'identifiant (le début d'un UUIDv7 est un horodatage).
    name: `${basename(cwd) || "codex"}-${sessionId.slice(-4)}`,
    cwd,
    version: meta.version ?? "?",
    status: snapshot.status,
    // Sans en-tête daté : l'instant de découverte, stable d'un tick à l'autre (le tri par `startedAt` le serait sinon pas).
    startedAt: meta.startedAt ?? snapshot.discoveredAt,
    statusUpdatedAt: snapshot.statusUpdatedAt,
    model: snapshot.model,
    // Un abonnement ChatGPT n'a pas de prix par token ; Codex ne publie aucun coût.
    costUsd: null,
    contextPercent: snapshot.contextPercent,
    contextWindowSize: snapshot.contextWindowSize,
  };
}

function forgetMissing<T>(trackers: Map<string, T>, alive: Set<string>): void {
  for (const key of trackers.keys()) {
    if (!alive.has(key)) trackers.delete(key);
  }
}
