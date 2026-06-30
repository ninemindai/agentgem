// src/gem/__tests__/sessionLessons.test.ts
import { describe, it, expect } from "vitest";
import { distillSessionLessons, validateSessionLessons } from "@agentgem/insight";
import type { WorkflowSignal, SessionSequence, AcpConnectFn } from "@agentgem/insight";

function sess(id: string, task: string | null): SessionSequence {
  const base: SessionSequence = {
    steps: [{ tool: "Bash", verb: "Bash:git commit", arg: "git commit", msgIndex: 4 }],
    sessionId: id, transcript: `${id}.jsonl`, atMs: 100,
  };
  return task === null ? base : { ...base, missionHint: { task, outcome: "fixed the flaky CI after 3 tries" } };
}
function signalWith(s: SessionSequence[]): WorkflowSignal {
  return { root: "/r", flavor: "claude", sessions: { scanned: s.length, firstMs: 0, lastMs: 0, spanDays: 0 },
    models: [], artifacts: [], unresolved: [], coOccurrence: [], shapes: [], notes: [], sequences: { root: "/r", sessions: s } };
}
// Fake agent: asserts plan mode before prompting, returns canned text.
function fakeConnect(canned: string): AcpConnectFn {
  return async () => ({ ctx: { async open(_cwd: string) { let mode = "default";
    return { async setMode(m: string) { mode = m; },
      async promptText(_t: string) { if (mode !== "plan") throw new Error(`expected plan, got ${mode}`); return canned; },
      dispose() {} }; } }, close() {} });
}
const inv = { project: { root: "/r", name: "app", skills: [], mcpServers: [], instructions: [], hooks: [] },
  global: { skills: [], mcpServers: [], hooks: [] } } as never;

describe("distillSessionLessons", () => {
  it("distills lessons from the agent response with server-attached provenance", async () => {
    const canned = JSON.stringify({ lessons: [
      { body: "Pin the flaky test's seed before debugging — randomness hid the real failure.", importance: "high" },
    ] });
    const { lessons, degraded } = await distillSessionLessons(signalWith([sess("a", "Fix flaky CI")]), inv, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].status).toBe("draft");
    expect(lessons[0].importance).toBe("high");
    expect(lessons[0].name).toBe("pin-the-flaky-tests-seed-before-debugging");
    expect(lessons[0].evidence.sessions).toBe(1);
    expect(lessons[0].evidence.root).toBe("/r");
    expect(lessons[0].evidence.provenance.occurrences[0].sessionId).toBe("a");
    expect(lessons[0].evidence.provenance.occurrences[0].messageIndices).toEqual([4]);
    expect(JSON.stringify(lessons[0].evidence.provenance)).not.toContain("Pin the flaky"); // provenance carries no body text
  });
  it("re-scrubs a body the agent returns (no secret leaks into the lesson)", async () => {
    const canned = JSON.stringify({ lessons: [{ body: "Rotate the token sk-abcdefghijklmnop after the leak.", importance: "medium" }] });
    const { lessons } = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: fakeConnect(canned) });
    expect(lessons[0].body).not.toContain("sk-abcdefghijklmnop");
  });
  it("returns empty non-degraded when the session has no mission hint (agent not invoked)", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", null)]), inv, {
      connectFn: async () => { throw new Error("should not be called"); } });
    expect(r).toEqual({ lessons: [], degraded: false });
  });
  it("degrades to empty on agent error", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: async () => { throw new Error("no binary"); } });
    expect(r).toEqual({ lessons: [], degraded: true });
  });
  it("returns [] non-degraded on malformed JSON (the agent RAN — degraded means only 'agent could not run')", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: fakeConnect("not json") });
    expect(r).toEqual({ lessons: [], degraded: false });
  });
  it("returns [] non-degraded on a valid empty result (no lesson worth sharing is NOT degraded)", async () => {
    const r = await distillSessionLessons(signalWith([sess("a", "x")]), inv, { connectFn: fakeConnect(JSON.stringify({ lessons: [] })) });
    expect(r).toEqual({ lessons: [], degraded: false });
  });
});

describe("validateSessionLessons", () => {
  const s = sess("a", "x");
  it("de-duplicates colliding lesson names", () => {
    const raw = { lessons: [{ body: "Same lesson text.", importance: "high" }, { body: "Same lesson text.", importance: "medium" }] };
    const out = validateSessionLessons(raw, s, "/r");
    expect(out.map((l) => l.name)).toEqual(["same-lesson-text", "same-lesson-text-2"]);
  });
  it("defaults a missing/invalid importance to medium and drops empty bodies", () => {
    const raw = { lessons: [{ body: "Keep it.", importance: "bogus" }, { body: "   " }] };
    const out = validateSessionLessons(raw, s, "/r");
    expect(out).toHaveLength(1);
    expect(out[0].importance).toBe("medium");
  });
});
