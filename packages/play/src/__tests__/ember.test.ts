import { describe, it, expect } from "vitest";
import { EMBER_META, EMBER_HTML } from "../ember.js";

describe("EMBER built-in miniapp", () => {
  it("declares the context-hygiene need and the built-in name", () => {
    expect(EMBER_META.name).toBe("__ember");
    expect(EMBER_META.genre).toBe("session-heatmap");
    expect(EMBER_META.needs).toContain("context-hygiene");
  });

  it("HTML calls the hygiene tool literally + carries the flame gauge", () => {
    expect(EMBER_HTML).toContain("agentgem_subscribe_hygiene");
    expect(EMBER_HTML).toContain('id="fill"'); // the gauge element the live event drives
    // Word-list trap: served constants skip gameGate, but keep the doc clean of network keywords anyway.
    expect(EMBER_HTML).not.toMatch(/EventSource|XMLHttpRequest|WebSocket|sendBeacon/);
  });
});
