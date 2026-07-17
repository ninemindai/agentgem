import { describe, it, expect } from "vitest";
import { detectWarm, detectDream } from "./events.js";

describe("detectWarm", () => {
  it("does not fire on the first snapshot (no prev)", () => {
    expect(detectWarm(null, { running: false })).toBeNull();
    expect(detectWarm(null, { running: true })).toBeNull();
  });
  it("fires when running goes true → false", () => {
    const e = detectWarm({ running: true }, { running: false });
    expect(e?.key).toBe("warm-finished");
    expect(e?.title).toBe("Warm pass finished");
  });
  it("does not fire on false → true or unchanged", () => {
    expect(detectWarm({ running: false }, { running: true })).toBeNull();
    expect(detectWarm({ running: true }, { running: true })).toBeNull();
    expect(detectWarm({ running: false }, { running: false })).toBeNull();
  });
});

describe("detectDream", () => {
  it("does not fire on the first snapshot (no prev)", () => {
    expect(detectDream(null, { queued: 3 })).toBeNull();
  });
  it("fires with a singular message when queued rises by 1", () => {
    const e = detectDream({ queued: 0 }, { queued: 1 });
    expect(e?.key).toBe("dream-queue");
    expect(e?.message).toBe("1 new item to review.");
  });
  it("fires with a pluralized delta when queued rises by more than 1", () => {
    const e = detectDream({ queued: 2 }, { queued: 5 });
    expect(e?.message).toBe("3 new items to review.");
  });
  it("does not fire when queued stays or drops", () => {
    expect(detectDream({ queued: 4 }, { queued: 4 })).toBeNull();
    expect(detectDream({ queued: 4 }, { queued: 2 })).toBeNull();
  });
});

import { detectAttention, carryVanishedPending, type AttentionSnapshot } from "./events.js";

const snap = (sessions: AttentionSnapshot["sessions"]): AttentionSnapshot => ({ sessions });
const pending = (over: Partial<AttentionSnapshot["sessions"][0]> = {}) => ({
  id: "s1", file: "/t/s1.jsonl", project: "site",
  state: "pending" as const, pendingKey: 4, pendingToolName: "Bash", ...over,
});

describe("detectAttention", () => {
  it("is silent on the first snapshot (baseline)", () => {
    expect(detectAttention(null, snap([pending()]), new Set(["/t/s1.jsonl"]))).toEqual([]);
  });

  it("fires once when an enrolled session transitions into pending", () => {
    const events = detectAttention(snap([{ ...pending(), state: "busy", pendingKey: null, pendingToolName: null }]), snap([pending()]), new Set(["/t/s1.jsonl"]));
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("attention-s1-4");
    expect(events[0].title).toBe("Session needs your input");
    expect(events[0].message).toBe("site — waiting on approval for Bash (or a long tool run).");
  });

  it("does not re-fire while the same stall persists", () => {
    expect(detectAttention(snap([pending()]), snap([pending()]), new Set(["/t/s1.jsonl"]))).toEqual([]);
  });

  it("fires again for a later, different stall (new pendingKey)", () => {
    const events = detectAttention(snap([pending()]), snap([pending({ pendingKey: 9, pendingToolName: "Write" })]), new Set(["/t/s1.jsonl"]));
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("attention-s1-9");
  });

  it("ignores sessions that are not enrolled", () => {
    expect(detectAttention(snap([]), snap([pending()]), new Set())).toEqual([]);
  });

  it("falls back to the id prefix when project is null", () => {
    const events = detectAttention(snap([]), snap([pending({ project: null, id: "abcdef1234" })]), new Set(["/t/s1.jsonl"]));
    expect(events[0].message).toBe("abcdef12 — waiting on approval for Bash (or a long tool run).");
  });
});

describe("carryVanishedPending", () => {
  const p = (over: Partial<AttentionSnapshot["sessions"][0]> = {}) => ({
    id: "s1", file: "/t/s1.jsonl", project: "site",
    state: "pending" as const, pendingKey: 4, pendingToolName: "Bash", ...over,
  });

  it("passes next through when nothing vanished", () => {
    const next = snap([p()]);
    expect(carryVanishedPending(snap([p()]), next)).toBe(next);
  });

  it("carries a vanished pending session into the stored baseline", () => {
    const carried = carryVanishedPending(snap([p()]), snap([]));
    expect(carried.sessions).toEqual([p()]);
  });

  it("does not carry vanished idle/busy sessions", () => {
    const carried = carryVanishedPending(snap([p({ state: "busy", pendingKey: null, pendingToolName: null })]), snap([]));
    expect(carried.sessions).toEqual([]);
  });

  it("suppresses a re-fire when a pending session vanishes for one poll and returns with the same key", () => {
    const enrolled = new Set(["/t/s1.jsonl"]);
    const s1 = snap([p()]);                                   // pending (already alerted earlier)
    const s2 = carryVanishedPending(s1, snap([]));            // transient read failure — s1 gone
    expect(detectAttention(s2, snap([p()]), enrolled)).toEqual([]); // same stall returns → silent
    expect(detectAttention(s2, snap([p({ pendingKey: 9 })]), enrolled)).toHaveLength(1); // NEW stall → fires
  });
});
