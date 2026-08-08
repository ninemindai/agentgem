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

// Run one gate call in a SEPARATE PROCESS and return its result.
//
// Two tests need this for different reasons:
//   - the rejection-policy test cannot set --unhandled-rejections in-process;
//   - the allocation test must not do its allocating inside a vitest fork. It did once, and on a
//     2-core CI runner with ~400 test files in parallel the fork was killed outright ("Worker
//     exited unexpectedly"), taking this whole file's results with it while every assertion in it
//     had passed. Bounding the smoke worker's heap does not bound the pressure the surrounding
//     process feels; only another process does.
//
// The module URL is resolved here rather than passed as a bare specifier, so the child does not
// depend on its cwd resolving the workspace package.
async function gateInChildProcess(html: string, env: NodeJS.ProcessEnv = {}) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const playUrl = import.meta.resolve("@agentgem/play");
  const src = `
    const { gameGate } = await import(${JSON.stringify(playUrl)});
    console.log(JSON.stringify(await gameGate(${JSON.stringify(html)})));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", src], {
    env: { ...process.env, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as { ok: boolean; failures: string[] };
}

describe("gameGate — worker isolation", () => {
  it("kills a synchronous infinite loop and reports it, instead of hanging forever", async () => {
    const r = await gameGate(page("while(true){}"));
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("did not finish"))).toBe(true);
  }, 20_000);

  it("contains unbounded allocation", async () => {
    // Runs in a child process — see gateInChildProcess. Allocating inside the vitest fork killed
    // the fork on CI. Slabs are ~40 MB, not ~8 MB: both trip the 128 MB ceiling, but small slabs
    // GC-thrash under the limit for seconds first, and that pressure is what breaks neighbours.
    const r = await gateInChildProcess(page("const a=[];while(true){a.push(new Array(5e6).fill(7))}"));
    // Either the heap ceiling kills the worker ('exit'/'error') or the wall clock does ('timeout').
    // Which one wins is a timing race; both are correct, and both must be a gate failure.
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 60_000);

  it("reports an async escape as a failure rather than crashing the host", async () => {
    // `NotAThing` is undefined inside the DOM, so the rejection escapes the awaited boot() the same
    // way Path2D did before it was stubbed.
    const r = await gameGate(page("(async()=>{ await 0; new NotAThing(); })()"));
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  }, 20_000);

  it("still passes a good bundle after the failures above (host is reusable)", async () => {
    expect(await gameGate(page("document.body.textContent='ok'"))).toMatchObject({ ok: true, failures: [] });
  }, 20_000);

  it("fails an async escape even under --unhandled-rejections=warn", async () => {
    // The worker must trap the rejection itself. Relying on Node turning it into the parent's
    // 'error' event is relying on a *policy*: flip this flag and the rejection only warns, the
    // worker posts ok:true, and a broken bundle is ADMITTED. That false pass is worse than the
    // crash the worker boundary exists to prevent, and it shipped once in this file's history.
    const r = await gateInChildProcess(page("(async()=>{await 0;new NotAThing();})()"), {
      NODE_OPTIONS: "--unhandled-rejections=warn",
    });
    expect(r.ok).toBe(false);
  }, 60_000);

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
    expect(await gameGate(big)).toMatchObject({ ok: true, failures: [] });
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
