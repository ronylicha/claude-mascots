import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avatarFor, HAIR_COLOR_COUNT, HAIR_STYLE_COUNT, SKIN_TONE_COUNT } from "../src/domain/avatar.ts";
import { deriveActivity, deriveMood, deriveMoodState, MOOD_THRESHOLDS } from "../src/domain/behavior.ts";
import type { AccountQuota } from "../src/types.ts";

const NOW = 1_000_000_000;
const SLEEP = 10 * 60_000;
const quota = (fiveHour: number, sevenDay = 0): AccountQuota => ({
  fiveHour: { usedPercent: fiveHour, resetsAt: null },
  sevenDay: { usedPercent: sevenDay, resetsAt: null },
  source: "statusline",
  observedAt: NOW,
});

describe("deriveActivity", () => {
  it("works while Claude Code reports busy", () => {
    assert.equal(deriveActivity({ registryStatus: "busy", statusUpdatedAt: 0, lastActivityAt: null, now: NOW, sleepAfterMs: SLEEP }), "working");
  });

  it("waits when a permission or an answer is pending", () => {
    assert.equal(deriveActivity({ registryStatus: "waiting_for_permission", statusUpdatedAt: NOW, lastActivityAt: null, now: NOW, sleepAfterMs: SLEEP }), "waiting");
  });

  it("idles, then falls asleep after the delay", () => {
    const base = { registryStatus: "idle", lastActivityAt: null, now: NOW, sleepAfterMs: SLEEP };
    assert.equal(deriveActivity({ ...base, statusUpdatedAt: NOW - 60_000 }), "idle");
    assert.equal(deriveActivity({ ...base, statusUpdatedAt: NOW - SLEEP - 1 }), "sleeping");
  });

  it("stays awake when the transcript shows recent activity", () => {
    assert.equal(deriveActivity({ registryStatus: "idle", statusUpdatedAt: 0, lastActivityAt: NOW - 1000, now: NOW, sleepAfterMs: SLEEP }), "idle");
  });
});

describe("deriveMood", () => {
  it("is focused while working and happy at rest when everything is fine", () => {
    assert.equal(deriveMood({ activity: "working", contextPercent: 10, quota: quota(5) }), "focused");
    assert.equal(deriveMood({ activity: "idle", contextPercent: 10, quota: quota(5) }), "happy");
  });

  it("worries for the whole troupe when the shared quota runs low", () => {
    assert.equal(deriveMood({ activity: "idle", contextPercent: 0, quota: quota(80) }), "worried");
    assert.equal(deriveMood({ activity: "idle", contextPercent: 0, quota: quota(10, 85) }), "worried");
  });

  it("gets tired from a heavy context and exhausted near the limits", () => {
    assert.equal(deriveMood({ activity: "working", contextPercent: 75, quota: quota(5) }), "tired");
    assert.equal(deriveMood({ activity: "working", contextPercent: 92, quota: quota(5) }), "exhausted");
    assert.equal(deriveMood({ activity: "working", contextPercent: 5, quota: quota(97) }), "exhausted");
  });

  it("treats an unknown quota as no pressure", () => {
    assert.equal(deriveMood({ activity: "idle", contextPercent: null, quota: { fiveHour: null, sevenDay: null, source: "none", observedAt: null } }), "happy");
  });
});

describe("deriveMoodState", () => {
  const idle = (contextPercent: number | null, fiveHour: number, sevenDay = 0) =>
    deriveMoodState({ activity: "idle", contextPercent, quota: quota(fiveHour, sevenDay) });

  it("names no cause for a happy or focused character", () => {
    assert.deepEqual(idle(10, 5), { mood: "happy", cause: null });
    assert.deepEqual(deriveMoodState({ activity: "working", contextPercent: 10, quota: quota(5) }), { mood: "focused", cause: null });
  });

  it("blames the 5-hour quota, the weekly quota or the context for each negative mood", () => {
    assert.deepEqual(idle(0, 97), { mood: "exhausted", cause: "quota5h" });
    assert.deepEqual(idle(95, 0), { mood: "exhausted", cause: "context" });
    assert.deepEqual(idle(0, 82), { mood: "worried", cause: "quota5h" });
    assert.deepEqual(idle(0, 10, 90), { mood: "worried", cause: "quota7d" });
    assert.deepEqual(idle(75, 0), { mood: "tired", cause: "context" });
  });

  it("lets the shared quota win when both causes reach the same level", () => {
    assert.deepEqual(idle(95, 97), { mood: "exhausted", cause: "quota5h" });
    assert.deepEqual(idle(75, 10, 90), { mood: "worried", cause: "quota7d" });
  });

  it("switches exactly on each threshold of MOOD_THRESHOLDS", () => {
    const { fiveHourExhausted, fiveHourWorried, sevenDayWorried, contextExhausted, contextTired } = MOOD_THRESHOLDS;
    assert.equal(idle(0, fiveHourExhausted).mood, "exhausted");
    assert.equal(idle(0, fiveHourExhausted - 1).mood, "worried");
    assert.equal(idle(0, fiveHourWorried).cause, "quota5h");
    assert.equal(idle(0, fiveHourWorried - 1).mood, "happy");
    assert.equal(idle(0, 0, sevenDayWorried).cause, "quota7d");
    assert.equal(idle(0, 0, sevenDayWorried - 1).cause, null);
    assert.equal(idle(contextExhausted, 0).mood, "exhausted");
    assert.equal(idle(contextExhausted - 1, 0).mood, "tired");
    assert.equal(idle(contextTired, 0).cause, "context");
    assert.equal(idle(contextTired - 1, 0).cause, null);
  });

  it("reports no cause when the quota is unknown and the context too", () => {
    const unknown: AccountQuota = { fiveHour: null, sevenDay: null, source: "none", observedAt: null };
    assert.deepEqual(deriveMoodState({ activity: "idle", contextPercent: null, quota: unknown }), { mood: "happy", cause: null });
  });
});

describe("avatarFor", () => {
  it("is deterministic and keeps every index inside the sprite lists", () => {
    const id = "0702150f-d8d9-4dc0-83a3-bd0c789053c5";
    assert.deepEqual(avatarFor(id), avatarFor(id));
    for (let index = 0; index < 500; index += 1) {
      const avatar = avatarFor(`session-${index}`);
      assert.ok(avatar.skin >= 0 && avatar.skin < SKIN_TONE_COUNT);
      assert.ok(avatar.hair >= 0 && avatar.hair < HAIR_COLOR_COUNT);
      assert.ok(avatar.hairStyle >= 0 && avatar.hairStyle < HAIR_STYLE_COUNT);
      assert.ok(Number.isInteger(avatar.hue) && avatar.hue >= 0 && avatar.hue < 360);
    }
  });
});
