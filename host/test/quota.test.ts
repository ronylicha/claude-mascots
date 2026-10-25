import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCachedUsageWindow, parseRateLimitWindow, resolveAccountQuota } from "../src/sources/quota.ts";
import type { AccountQuota, StatuslineSnapshot } from "../src/types.ts";

const NOW = Date.parse("2026-10-24T03:30:00Z");
const STALE = 15 * 60_000;

function snapshot(observedAt: number, fiveHourPercent: number): StatuslineSnapshot {
  return {
    sessionId: `s-${observedAt}`,
    transcriptPath: null,
    modelName: null,
    costUsd: null,
    contextUsedPercent: null,
    contextWindowSize: null,
    quota: { fiveHour: { usedPercent: fiveHourPercent, resetsAt: NOW + 3_600_000 }, sevenDay: null },
    observedAt,
  };
}

describe("quota parsing", () => {
  it("reads Claude Code's native rate_limits (epoch seconds)", () => {
    assert.deepEqual(parseRateLimitWindow({ used_percentage: 42, resets_at: 1792821000 }), { usedPercent: 42, resetsAt: 1792821000_000 });
  });

  it("reads the statusline cache format (ISO date) and clamps percentages", () => {
    assert.deepEqual(parseCachedUsageWindow({ utilization: 130, resets_at: "2026-10-24T05:50:00.256511+00:00" }), {
      usedPercent: 100,
      resetsAt: Date.parse("2026-10-24T05:50:00.256Z"),
    });
  });

  it("rejects malformed windows", () => {
    assert.equal(parseRateLimitWindow({ used_percentage: "12" }), null);
    assert.equal(parseCachedUsageWindow(null), null);
  });
});

describe("resolveAccountQuota", () => {
  it("prefers the most recent observation across sessions and the cache", () => {
    const cache: AccountQuota = { fiveHour: { usedPercent: 5, resetsAt: null }, sevenDay: null, source: "cache", observedAt: NOW - 60_000 };
    const quota = resolveAccountQuota([snapshot(NOW - 120_000, 10), snapshot(NOW - 30_000, 12)], cache, NOW, STALE);
    assert.equal(quota.source, "statusline");
    assert.equal(quota.fiveHour?.usedPercent, 12);
  });

  it("falls back to the cache when snapshots are older", () => {
    const cache: AccountQuota = { fiveHour: { usedPercent: 7, resetsAt: null }, sevenDay: null, source: "cache", observedAt: NOW - 10_000 };
    assert.equal(resolveAccountQuota([snapshot(NOW - 600_000, 3)], cache, NOW, STALE).source, "cache");
  });

  it("reports no source when everything is stale", () => {
    const quota = resolveAccountQuota([snapshot(NOW - STALE - 1, 3)], null, NOW, STALE);
    assert.equal(quota.source, "none");
    assert.equal(quota.fiveHour, null);
  });

  it("resets a window whose reset time has passed", () => {
    const old = snapshot(NOW - 60_000, 88);
    old.quota.fiveHour = { usedPercent: 88, resetsAt: NOW - 1 };
    assert.deepEqual(resolveAccountQuota([old], null, NOW, STALE).fiveHour, { usedPercent: 0, resetsAt: null });
  });
});
