import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
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

  it("a pushed hygiene event drives the gauge fill from ctxTokens/cap and hides the DEMO badge", () => {
    // jsdom has no canvas 2D context (render() no-ops); the game's DOM logic still runs. __emberFeed is
    // the same function the host-brokered onNotification calls, so this exercises the real live mapping.
    const dom = new JSDOM(EMBER_HTML, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/" });
    const w = dom.window as unknown as { __emberFeed?: (e: unknown) => void; document: Document };
    expect(typeof w.__emberFeed).toBe("function");
    w.__emberFeed!({ type: "hygiene", verdict: "bloated", cap: 200000, curveTail: [{ turn: 9, msgIndex: 18, ctxTokens: 160000, cacheCreation: 0, outTokens: 0 }] });
    const fill = w.document.getElementById("fill") as HTMLElement;
    expect(parseFloat(fill.style.width)).toBeGreaterThan(75); // 160000/200000 = 80%
    expect(parseFloat(fill.style.width)).toBeLessThanOrEqual(100);
    expect((w.document.getElementById("demoBadge") as HTMLElement).style.display).toBe("none"); // live -> no DEMO
    dom.window.close();
  });

  it("declares copy-command and copies /compact on a live clean-cut BANK", () => {
    expect(EMBER_META.needs).toContain("copy-command");
    expect(EMBER_HTML).toContain("copyCommand");
    const dom = new JSDOM(EMBER_HTML, { runScripts: "dangerously", pretendToBeVisual: true, url: "https://localhost/" });
    const w = dom.window as unknown as { __emberFeed?: (e: unknown) => void; agentgemApp?: unknown; document: Document };
    const copied: string[] = [];
    // Attach a host stub AFTER construction — EMBER reads window.agentgemApp fresh at BANK time.
    w.agentgemApp = {
      onNotification() {}, callTool() { return Promise.resolve({}); },
      copyCommand(t: string) { copied.push(t); return Promise.resolve({}); },
    };
    // Drive into the sweet spot: cap 200k, ctx 60k = 30% (within [14%, 32%]).
    w.__emberFeed!({ type: "hygiene", cap: 200000, curveTail: [{ turn: 10, msgIndex: 20, ctxTokens: 60000, cacheCreation: 0, outTokens: 0 }] });
    (w.document.getElementById("bank") as HTMLElement).click();
    expect(copied).toContain("/compact");
    dom.window.close();
  });
});
