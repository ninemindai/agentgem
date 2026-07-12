import { describe, it, expect } from "vitest";
import { isGameHtmlRequest, overLimit, MAX_RECENT } from "./swCache";
import { PINNED_CACHE } from "./offline";
import { PINNED_CACHE as SW_PINNED } from "./swCache";

describe("swCache", () => {
  it("matches only the game-html endpoint, any origin", () => {
    expect(isGameHtmlRequest(new URL("https://api.agentgem.ai/api/aggregator/game-html?key=x&version=1"))).toBe(true);
    expect(isGameHtmlRequest(new URL("https://api.agentgem.ai/api/aggregator/game-meta?key=x"))).toBe(false);
    expect(isGameHtmlRequest(new URL("https://app.agentgem.ai/gems/x"))).toBe(false);
  });

  it("overLimit returns the oldest entries beyond the cap (insertion order)", () => {
    const keys = Array.from({ length: MAX_RECENT + 3 }, (_, i) => new Request(`https://api.test/api/aggregator/game-html?key=${i}`));
    const evict = overLimit(keys, MAX_RECENT);
    expect(evict).toHaveLength(3);
    expect(evict[0].url).toContain("key=0");   // oldest first
    expect(overLimit(keys.slice(0, 5), MAX_RECENT)).toHaveLength(0);
  });

  it("pinned cache name stays in sync with the app-side store", () => {
    expect(SW_PINNED).toBe(PINNED_CACHE);
  });
});
