// src/play/__tests__/miniappGate.package.test.ts
//
// Covers the package boundary itself, which the other four gameGate test files deliberately do NOT:
// they import from `@agentgem/play` (unchanged, which is what proves the extraction preserved
// behavior). That leaves two things untested, and both are silent failures if they regress:
//
//   1. `@ninemind/miniapp-gate` is consumable on its own. Every other test reaches the gate through
//      play's re-export, so play could stop re-exporting — or the new package could ship a broken
//      entrypoint — and the suite would stay green for the wrong reason.
//   2. `gameGate` threads its `opts` down into `staticGate`. It does (`gameGate` line 1 calls
//      `staticGate(html, opts)`), but nothing asserted it. Drop that argument and `allowNetwork`
//      silently stops working on the async path while every staticGate test still passes.
import { describe, it, expect } from "vitest";
import { gameGate, staticGate, scannableCode, redactForBake } from "@ninemind/miniapp-gate";
import { gameGate as playGameGate, redactForBake as playRedactForBake } from "@agentgem/play";

describe("@ninemind/miniapp-gate package boundary", () => {
  it("exports the gate surface directly, without going through @agentgem/play", () => {
    expect(typeof gameGate).toBe("function");
    expect(typeof staticGate).toBe("function");
    expect(typeof scannableCode).toBe("function");
    expect(typeof redactForBake).toBe("function");
  });

  it("is the SAME function play re-exports — a copy would mean two gates that can drift", () => {
    // Identity, not just shape. The whole point of the extraction is one gate, not two.
    expect(playGameGate).toBe(gameGate);
    expect(playRedactForBake).toBe(redactForBake);
  });
});

describe("gameGate threads GateOptions into the static pass", () => {
  const netCall = `<!doctype html><body><script>
    // Never runs under jsdom (no server), but its mere presence trips NETWORK_CALL.
    if (globalThis.__never) fetch("https://host.example.com/mcp");
  </script></body>`;

  it("rejects a network call on the async path by default", async () => {
    const r = await gameGate(netCall);
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("network"))).toBe(true);
  });

  it("admits it under allowNetwork and still runs the smoke", async () => {
    // Passing means BOTH that opts reached staticGate (no 'network' failure) and that the bundle
    // then survived the worker smoke — so this one assertion guards the thread-through and proves
    // the async path is still wired to the worker.
    const r = await gameGate(netCall, { allowNetwork: true });
    expect(r).toEqual({ ok: true, failures: [] });
  });

  it("still short-circuits before the smoke when a non-network static check fails", async () => {
    // allowNetwork must not turn the static pass into a no-op: a bundle that fails EXTERNAL_ATTR
    // should never reach the executor, which is the invariant the `:84` short-circuit encodes.
    const r = await gameGate(`<script src="https://cdn.example/x.js"></script>`, { allowNetwork: true });
    expect(r.ok).toBe(false);
    expect(r.failures.some((f) => f.includes("external"))).toBe(true);
  });
});
