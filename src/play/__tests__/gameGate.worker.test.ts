// src/play/__tests__/gameGate.worker.test.ts
//
// The smoke runs in a worker thread. These cover the three ways generated code can take the host
// down — none of which the previous main-thread implementation survived:
//   - a synchronous spin (blocks the event loop; no handler can run, so nothing could trap it);
//   - an async throw (killed the app on 2026-07-21 via `new Path2D(...)` in an awaited boot());
//   - unbounded allocation.
// Each must come back as an ordinary gate failure with the host still healthy afterwards.
import { describe, it, expect } from "vitest";
import { gameGate } from "@agentgem/play";

const page = (script: string) => `<!doctype html><body><script>${script}</script></body>`;

describe("gameGate — worker isolation", () => {
  it("kills a synchronous infinite loop and reports it, instead of hanging forever", async () => {
    const r = await gameGate(page("while(true){}"));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("did not finish"))).toBe(true);
  }, 20_000);

  it("contains unbounded allocation without taking the host heap with it", async () => {
    const before = process.memoryUsage().heapUsed;
    // Allocate in ~40 MB slabs, not ~8 MB ones. Both trip the 128 MB worker ceiling, but small
    // slabs spend seconds GC-thrashing just under the limit first, and that sustained pressure
    // is enough to make a sibling test's child-process pipe fail with EPIPE when the whole suite
    // runs in parallel. Big slabs hit the wall in a few allocations with almost no churn.
    const r = await gameGate(page("const a=[];while(true){a.push(new Array(5e6).fill(7))}"));
    expect(r.ok).toBe(false);
    // Either the heap ceiling kills the worker ('exit') or the wall clock does ('timeout') —
    // which one wins is a timing race and both are correct. What must hold is that the host's
    // own heap is untouched.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  }, 20_000);

  it("reports an async escape as a failure rather than crashing the host", async () => {
    // `NotAThing` is undefined inside the DOM, so the rejection escapes the awaited boot() the same
    // way Path2D did before it was stubbed.
    const r = await gameGate(page("(async()=>{ await 0; new NotAThing(); })()"));
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 20_000);

  it("still passes a good bundle after the failures above (host is reusable)", async () => {
    expect(await gameGate(page("document.body.textContent='ok'"))).toEqual({ ok: true, failures: [] });
  }, 20_000);

  it("fails an async escape even under --unhandled-rejections=warn", async () => {
    // The worker must trap the rejection itself. Relying on Node turning it into the parent's
    // 'error' event is relying on a *policy*: flip this flag and the rejection only warns, the
    // worker posts ok:true, and a broken bundle is ADMITTED. That false pass is worse than the
    // crash the worker boundary exists to prevent, and it shipped once in this file's history.
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const src = `
      import { gameGate } from "@agentgem/play";
      const r = await gameGate(\`<!doctype html><body><script>(async()=>{await 0;new NotAThing();})()</script></body>\`);
      console.log(JSON.stringify(r));
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", src],
      { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "--unhandled-rejections=warn" } },
    );
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(false);
  }, 30_000);

  it("passes a legitimate bundle close to the size cap", async () => {
    // Guards the resourceLimits ceiling against being tightened until it rejects real content.
    // Data lives in an application/json block, which the static scan exempts.
    const rows = Array.from({ length: 9000 }, (_, i) => ({ id: i, name: `entity-${i}`, note: "x".repeat(100) }));
    const big = `<!doctype html><body><canvas id="c"></canvas>
<script id="game-data" type="application/json">${JSON.stringify({ timeline: rows })}</script>
<script>
  const data = JSON.parse(document.getElementById("game-data").textContent);
  const ctx = document.getElementById("c").getContext("2d");
  let acc = 0; for (const r of data.timeline) { acc += r.id; ctx.fillRect(r.id % 100, 0, 1, 1); }
  document.body.setAttribute("data-acc", String(acc));
</script></body>`;
    expect(Buffer.byteLength(big)).toBeGreaterThan(1_000_000); // meaningfully near the 1.5 MB cap
    expect(await gameGate(big)).toEqual({ ok: true, failures: [] });
  }, 20_000);

  it("resolves rather than rejecting when the smoke cannot start", async () => {
    // saveMiniapp (miniapps.ts:127) awaits gameGate with no try/catch and formats gate.failures on
    // the next line. A rejection there surfaces as a raw stack instead of an actionable message, so
    // "always resolves" is the contract, not an implementation detail.
    await expect(gameGate(page("document.body.textContent='ok'"))).resolves.toHaveProperty("ok");
    const r = await gameGate(page("document.body.textContent='ok'"));
    expect(r).toHaveProperty("failures");
    expect(Array.isArray(r.failures)).toBe(true);
  }, 20_000);

  it("does not leave the host's process listeners mutated", async () => {
    // The previous implementation called process.removeAllListeners() around the smoke. A marker
    // listener must survive the gate untouched.
    const marker = () => {};
    process.on("uncaughtException", marker);
    try {
      await gameGate(page("document.body.textContent='ok'"));
      expect(process.listeners("uncaughtException")).toContain(marker);
    } finally {
      process.removeListener("uncaughtException", marker);
    }
  }, 20_000);
});
