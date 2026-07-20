import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamWatchEvents } from "@agentgem/app/watchEvents";

const POLL_MS = 1000;

// The stream validates ?file= against the real resolved home, so redirect HOME to a
// temp tree holding a live Claude session (an assistant text + an in-flight Bash call).
let origHome: string | undefined, home: string, claudeFile: string;
const rec = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  origHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "watchevents-"));
  process.env.HOME = home;
  const cproj = join(home, ".claude", "projects", "p");
  mkdirSync(cproj, { recursive: true });
  claudeFile = join(cproj, "claude-uuid.jsonl");
  writeFileSync(claudeFile, rec({
    type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
    message: { role: "assistant", content: [
      { type: "text", text: "running ls" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ] },
  }) + "\n");
});

afterAll(() => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// Drive streamWatchEvents with a fake req/res; the returned parse() reads whatever
// SSE blocks have accumulated so far, so we can inspect before and after a poll tick.
function harness(file: string) {
  vi.useFakeTimers();
  let buf = "";
  const res = { writeHead() {}, write(c: string) { buf += c; }, end() {} };
  streamWatchEvents({ query: { file }, on() {} } as never, res as never);
  const parse = () => {
    const events: { event: string; data: any }[] = [];
    for (const block of buf.split("\n\n")) {
      const em = /^event: (.+)$/m.exec(block);
      const dm = /^data: (.+)$/m.exec(block);
      if (em && dm) events.push({ event: em[1], data: JSON.parse(dm[1]) });
    }
    return events;
  };
  return { parse };
}

describe("streamWatchEvents", () => {
  it("rejects an out-of-scope file", () => {
    const { parse } = harness("/etc/passwd.jsonl");
    expect(parse()).toEqual([{ event: "failed", data: { message: "unknown or out-of-scope transcript file" } }]);
  });

  it("streams the backlog, then only NEW events as the transcript grows", () => {
    const { parse } = harness(claudeFile);

    // Backlog tick (synchronous): a phase, then the message + the in-flight tool_call.
    expect(parse().find((e) => e.event === "phase")?.data).toMatchObject({ phase: "watching", agent: "claude" });
    let ev = parse().filter((e) => e.event === "event");
    expect(ev.map((e) => e.data.span.kind)).toEqual(["message", "tool_call"]);
    expect(ev.map((e) => e.data.index)).toEqual([0, 1]);

    // The Bash call finishes — its result lands in a LATER user record.
    appendFileSync(claudeFile, rec({
      type: "user", timestamp: "2026-07-03T10:00:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts\nb.ts" }] },
    }) + "\n");
    // Force a strictly-greater mtime so the poll re-reads (FS mtime resolution is coarse).
    const t = Math.floor(statSync(claudeFile).mtimeMs / 1000) + 60;
    utimesSync(claudeFile, t, t);

    vi.advanceTimersByTime(POLL_MS); // fire exactly one poll tick

    ev = parse().filter((e) => e.event === "event");
    // The prior two are NOT re-sent; the result arrives as its own event, index 2.
    expect(ev.map((e) => e.data.span.kind)).toEqual(["message", "tool_call", "tool_result"]);
    expect(ev[2].data.index).toBe(2);
    expect(ev[2].data.span).toMatchObject({ kind: "tool_result", toolId: "t1" });
    expect(ev[2].data.span.output).toContain("a.ts");
  });
});
