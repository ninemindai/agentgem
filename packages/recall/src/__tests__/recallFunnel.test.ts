// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { recallFunnel, RECALL_CAP } from "../recallFunnel.js";
import type { FunnelDeps, FunnelEvent, SessionRef } from "../recallFunnel.js";

const refs = (n: number): SessionRef[] => Array.from({ length: n }, (_, i) => ({ sessionId: `s${i}`, agent: "claude" }));

function fakeDeps(over: Partial<FunnelDeps> = {}): FunnelDeps {
  return {
    async askOne(ref) { return { answered: true, answer: `answer for ${ref.sessionId}` }; },
    async *synthesize(answers) { yield `synthesis of ${answers.length}`; },
    ...over,
  };
}
async function collect(gen: AsyncGenerator<FunnelEvent>): Promise<FunnelEvent[]> {
  const out: FunnelEvent[] = []; for await (const e of gen) out.push(e); return out;
}

describe("recallFunnel", () => {
  it("asks each session, then synthesizes, ending with done", async () => {
    const events = await collect(recallFunnel({ sessions: refs(2), prompt: "q", mode: "extract" }, fakeDeps()));
    expect(events.filter((e) => e.type === "session_done")).toHaveLength(2);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", synthesis: "synthesis of 2" });
    expect((done as any).answers[0]).toMatchObject({ sessionId: "s0", answered: true });
  });

  it("caps the scanned set and emits a capped event", async () => {
    const events = await collect(recallFunnel({ sessions: refs(20), prompt: "q", mode: "extract" }, fakeDeps()));
    expect(events.find((e) => e.type === "capped")).toMatchObject({ scanned: RECALL_CAP, requested: 20, cap: RECALL_CAP });
    expect(events.filter((e) => e.type === "session_done")).toHaveLength(RECALL_CAP);
  });

  it("marks a failed session degraded but keeps going", async () => {
    const deps = fakeDeps({ async askOne(ref) { return ref.sessionId === "s1" ? { answered: false, answer: "failed" } : { answered: true, answer: "ok" }; } });
    const events = await collect(recallFunnel({ sessions: refs(3), prompt: "q", mode: "extract" }, deps));
    const done = events.find((e) => e.type === "session_done" && (e as any).sessionId === "s1");
    expect(done).toMatchObject({ answered: false });
    expect(events.at(-1)!.type).toBe("done");
  });

  it("stops early and emits cancelled when the signal aborts", async () => {
    const ctrl = new AbortController();
    const deps = fakeDeps({ async askOne(ref) { if (ref.sessionId === "s0") ctrl.abort(); return { answered: true, answer: "x" }; } });
    const events = await collect(recallFunnel({ sessions: refs(9), prompt: "q", mode: "extract", signal: ctrl.signal }, deps));
    expect(events.at(-1)!.type).toBe("cancelled");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("never runs more than `concurrency` asks at once", async () => {
    let inFlight = 0, peak = 0;
    const deps = fakeDeps({ concurrency: 2, async askOne() {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5)); inFlight--; return { answered: true, answer: "x" };
    } });
    await collect(recallFunnel({ sessions: refs(6), prompt: "q", mode: "extract" }, deps));
    expect(peak).toBeLessThanOrEqual(2);
  });
});
