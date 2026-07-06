// src/play/__tests__/gameGate.smoke.test.ts
import { describe, it, expect } from "vitest";
import { gameGate } from "@agentgem/play";

const good = `<!doctype html><body><canvas id="c"></canvas>
<script>const el=document.getElementById("c"); el.setAttribute("data-ok","1");</script></body>`;

describe("gameGate (static + jsdom smoke)", () => {
  it("passes a bundle whose inline script runs without throwing", async () => {
    const r = await gameGate(good);
    expect(r).toEqual({ ok: true, failures: [] });
  });

  it("fails when the inline script throws on load", async () => {
    const r = await gameGate(`<!doctype html><body><script>throw new Error("boom")</script></body>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("boom") || f.includes("threw"))).toBe(true);
  });

  it("still enforces the static checks (short-circuits on a network call)", async () => {
    const r = await gameGate(`<script>fetch("http://x/")</script>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });
});
