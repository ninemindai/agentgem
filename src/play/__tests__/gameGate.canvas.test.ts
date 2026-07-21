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

// 2026-07-21 regression: a Path2D in an async boot() crashed the WHOLE SERVER on Save — the
// rejection escaped jsdom, and Node's default unhandledRejection behavior killed the process.
describe("async-escape containment", () => {
  it("Path2D (and canvas friends) exist in the smoke world", async () => {
    const r = await gameGate(`<!doctype html><body><canvas></canvas><script>
      const p = new Path2D("M0 0"); p.lineTo(1, 1);
      const m = new DOMMatrix(); m.scale(2);
    </script></body>`);
    expect(r.ok, r.failures.join("; ")).toBe(true);
  });

  it("a promise rejection in an async boot becomes a gate failure, not a process crash", async () => {
    const r = await gameGate(`<!doctype html><body><canvas></canvas><script>
      (async () => { await Promise.resolve(); throw new Error("boom-async"); })();
    </script></body>`);
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toContain("crashed asynchronously");
    expect(r.failures.join(" ")).toContain("boom-async");
  });

  it("the process-level listeners are restored after the smoke", async () => {
    const before = process.listeners("unhandledRejection").length;
    await gameGate(`<!doctype html><body><p>x</p></body>`);
    expect(process.listeners("unhandledRejection").length).toBe(before);
  });
});
