// src/play/__tests__/gameGate.canvas.test.ts
import { describe, it, expect } from "vitest";
import { gameGate } from "@agentgem/play";

// jsdom has no canvas backend; the gate must stub getContext so a real canvas game passes the smoke.
const canvasGame = `<!doctype html><body><canvas id="c" width="320" height="200"></canvas>
<script>
  const ctx = document.getElementById("c").getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0,0,320,200);
  ctx.font = "16px system-ui"; const w = ctx.measureText("hi").width;
  const g = ctx.createLinearGradient(0,0,1,1); g.addColorStop(0,"#fff");
  requestAnimationFrame(() => {});
</script></body>`;

describe("gameGate — canvas games", () => {
  it("passes a canvas game (getContext/measureText/gradient stubbed under jsdom)", async () => {
    expect(await gameGate(canvasGame)).toEqual({ ok: true, failures: [] });
  });
  it("still catches a genuine throw after canvas setup", async () => {
    const r = await gameGate(`<!doctype html><body><canvas id="c"></canvas>
      <script>document.getElementById("c").getContext("2d"); throw new Error("boom");</script></body>`);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("boom"))).toBe(true);
  });
});
