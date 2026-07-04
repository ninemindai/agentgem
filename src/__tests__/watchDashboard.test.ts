import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamWatchDashboard } from "../watchDashboard.js";
import type { RenderInput, RenderResult } from "@agentgem/insight";

const DEBOUNCE = 4000;
let origHome: string | undefined, home: string, claudeFile: string;
const rec = (o: unknown) => JSON.stringify(o);
const assistantToolUse = (id: string, name: string) => rec({
  type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input: { command: "ls" } }] },
});

beforeAll(() => {
  origHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "watchdash-"));
  process.env.HOME = home;
  const cproj = join(home, ".claude", "projects", "p");
  mkdirSync(cproj, { recursive: true });
  claudeFile = join(cproj, "dash-uuid.jsonl");
  writeFileSync(claudeFile, assistantToolUse("t1", "Bash") + "\n");
});
afterAll(() => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function harness(file: string, render: (i: RenderInput) => Promise<RenderResult>, opts = {}) {
  vi.useFakeTimers();
  let buf = "";
  const res = { writeHead() {}, write(c: string) { buf += c; }, end() {} };
  streamWatchDashboard({ query: { file }, on() {} } as never, res as never, { render, debounceMs: DEBOUNCE, ...opts });
  const parse = () => {
    const out: { event: string; data: any }[] = [];
    for (const block of buf.split("\n\n")) {
      const em = /^event: (.+)$/m.exec(block); const dm = /^data: (.+)$/m.exec(block);
      if (em && dm) out.push({ event: em[1], data: JSON.parse(dm[1]) });
    }
    return out;
  };
  const bump = () => { const t = Math.floor(statSync(file).mtimeMs / 1000) + 60; utimesSync(file, t, t); };
  return { parse, bump };
}

// Fresh transcript file per test (no cross-test event accumulation). Writes N tool_use
// events. Each is a distinct assistant record so detectEvents yields N tool_call events.
let fileSeq = 0;
function mkFile(ids: string[]): string {
  const cproj = join(process.env.HOME!, ".claude", "projects", "p");
  const f = join(cproj, `d${fileSeq++}.jsonl`);
  writeFileSync(f, ids.map((id) => assistantToolUse(id, "Bash")).join("\n") + "\n");
  return f;
}
// The backlog tick arms a debounce at t=0; a poll that later sees a NEW mtime re-arms to
// (poll+debounce). Advancing DEBOUNCE + one POLL (1000ms) + margin covers both.
const SETTLE = DEBOUNCE + 1100;

describe("streamWatchDashboard", () => {
  it("rejects an out-of-scope file (fatal)", () => {
    const { parse } = harness("/etc/passwd.jsonl", async () => ({ html: "<x/>", ok: true }));
    expect(parse()).toEqual([{ event: "failed", data: { message: "unknown or out-of-scope transcript file", fatal: true } }]);
  });

  it("coalesces events that arrive DURING the window into ONE render (delta = all)", async () => {
    let calls = 0; let seenDelta = 0;
    const render = async (i: RenderInput) => { calls++; seenDelta = i.deltaEvents.length; return { html: `<h1>v${calls}</h1>`, ok: true }; };
    const file = mkFile(["t1"]);                        // 1-event backlog at connect
    const { parse, bump } = harness(file, render);
    appendFileSync(file, assistantToolUse("t2", "Read") + "\n"); bump();   // …then two more within the debounce
    appendFileSync(file, assistantToolUse("t3", "Edit") + "\n"); bump();
    await vi.advanceTimersByTimeAsync(SETTLE);
    expect(calls).toBe(1);                              // one render, not three (#8)
    expect(seenDelta).toBe(3);
    expect(parse().filter((e) => e.event === "render")).toHaveLength(1);
  });

  it("on failure keeps prevHtml and RETRIES the delta on the next burst (reflectedCount preserved)", async () => {
    let calls = 0; const deltas: number[] = [];
    const render = async (i: RenderInput): Promise<RenderResult> => {
      calls++; deltas.push(i.deltaEvents.length);
      return calls === 1 ? { html: "", ok: false } : { html: "<h1>ok</h1>", ok: true }; // fail once, then succeed
    };
    const file = mkFile(["t1"]);
    const { parse, bump } = harness(file, render);
    await vi.advanceTimersByTimeAsync(SETTLE);          // render1 → ok:false (no advance)
    expect(calls).toBe(1); expect(deltas[0]).toBe(1);
    appendFileSync(file, assistantToolUse("t2", "Read") + "\n"); bump();
    await vi.advanceTimersByTimeAsync(SETTLE);          // render2 retries: delta still starts at 0 → 2 events
    expect(calls).toBe(2); expect(deltas[1]).toBe(2);   // reflectedCount was NOT advanced by the failure
    expect(parse().filter((e) => e.event === "render")).toHaveLength(1);
  });

  it("single in-flight: a burst during a render does not start a second call", async () => {
    let calls = 0; let resolve!: (r: RenderResult) => void;
    const render = (_i: RenderInput) => { calls++; return new Promise<RenderResult>((r) => { resolve = r; }); };
    const file = mkFile(["t1"]);
    const { bump } = harness(file, render);
    await vi.advanceTimersByTimeAsync(SETTLE);       // render1 fires and stays pending
    expect(calls).toBe(1);
    appendFileSync(file, assistantToolUse("t2", "Read") + "\n"); bump();
    await vi.advanceTimersByTimeAsync(SETTLE);       // tick arms, but inFlight → dirty, no 2nd call
    expect(calls).toBe(1);
    resolve({ html: "<h1>a</h1>", ok: true });       // finish render1 → finally re-arms (dirty)
    await vi.advanceTimersByTimeAsync(SETTLE);        // render2 fires with the mid-render event
    expect(calls).toBe(2);
  });

  it("ceiling: renders immediately (no debounce wait) when unreflected >= ceiling", async () => {
    let calls = 0;
    const render = async () => { calls++; return { html: "<h1>c</h1>", ok: true } as RenderResult; };
    harness(mkFile(["t1", "t2", "t3"]), render, { ceiling: 2 });
    await vi.advanceTimersByTimeAsync(1);            // well under DEBOUNCE — ceiling fires it now
    expect(calls).toBe(1);
  });

  it("periodic full-regenerate: the Kth render gets prevHtml='' and the whole event list", async () => {
    const inputs: RenderInput[] = [];
    const render = async (i: RenderInput) => { inputs.push(i); return { html: `<h1>${inputs.length}</h1>`, ok: true } as RenderResult; };
    const file = mkFile(["t1"]);
    const { bump } = harness(file, render, { fullRegenEvery: 1 });
    await vi.advanceTimersByTimeAsync(SETTLE);       // render 1 (prevHtml already "")
    appendFileSync(file, assistantToolUse("t2", "Read") + "\n"); bump();
    await vi.advanceTimersByTimeAsync(SETTLE);       // render 2 — rendersSinceFull(1) >= 1 → FULL
    expect(inputs).toHaveLength(2);
    expect(inputs[1].prevHtml).toBe("");            // rebuilt from scratch
    expect(inputs[1].deltaEvents).toHaveLength(2);  // whole session, not just the delta
  });
});
