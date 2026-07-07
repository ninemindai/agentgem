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
