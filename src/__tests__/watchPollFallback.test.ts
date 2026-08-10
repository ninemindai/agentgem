// src/__tests__/watchPollFallback.test.ts
// The watch SSE routes' ?poll=1 mode (ssePoll.ts): the same discriminated messages
// as one JSON body plus a cursor, so the console's stall watchdog can fall back to
// polling behind a buffering proxy without re-receiving backlog. Also locks the
// heartbeat as a NAMED `ping` event — a `:` comment is invisible to EventSource,
// which is exactly why the watchdog couldn't exist before.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, statSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamWatchEvents } from "@agentgem/app/watchEvents";
import { streamWatch } from "@agentgem/app/watchStream";

let origHome: string | undefined, home: string, claudeFile: string;
const rec = (o: unknown) => JSON.stringify(o);

beforeAll(() => {
  origHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), "watchpoll-"));
  process.env.HOME = home;
  const cproj = join(home, ".claude", "projects", "p");
  mkdirSync(cproj, { recursive: true });
  claudeFile = join(cproj, "claude-uuid.jsonl");
  writeFileSync(claudeFile, rec({
    type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
    message: { role: "assistant", content: [
      { type: "text", text: "writing the page" },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ] },
  }) + "\n");
});

afterAll(() => { process.env.HOME = origHome; rmSync(home, { recursive: true, force: true }); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

type Handler = (req: never, res: never) => void;
function poll(handler: Handler, query: Record<string, string>) {
  let buf = "";
  let headers: Record<string, string> = {};
  const res = { writeHead(_s: number, h: Record<string, string>) { headers = h; }, write(c: string) { buf += c; }, end() {} };
  handler({ query, on() {} } as never, res as never);
  return { body: JSON.parse(buf) as { messages: { event: string; data: any }[]; cursor: Record<string, unknown> }, headers };
}

describe("watch events ?poll=1", () => {
  it("returns the backlog as JSON messages with an after cursor", () => {
    const { body, headers } = poll(streamWatchEvents as Handler, { file: claudeFile, poll: "1", after: "0" });
    expect(headers["Content-Type"]).toBe("application/json");
    expect(body.messages[0]).toMatchObject({ event: "phase", data: { phase: "watching", agent: "claude" } });
    const events = body.messages.filter((m) => m.event === "event");
    expect(events.map((m) => m.data.span.kind)).toEqual(["message", "tool_call"]);
    expect(events.map((m) => m.data.index)).toEqual([0, 1]);
    expect(body.cursor).toEqual({ after: 2 });
  });

  it("skips events before the cursor and advances it", () => {
    appendFileSync(claudeFile, rec({
      type: "user", timestamp: "2026-07-03T10:00:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] },
    }) + "\n");
    const t = Math.floor(statSync(claudeFile).mtimeMs / 1000) + 60;
    utimesSync(claudeFile, t, t);

    const { body } = poll(streamWatchEvents as Handler, { file: claudeFile, poll: "1", after: "2" });
    const events = body.messages.filter((m) => m.event === "event");
    expect(events.length).toBe(1);
    expect(events[0].data).toMatchObject({ index: 2, span: { kind: "tool_result", toolId: "t1" } });
    expect(body.cursor).toEqual({ after: 3 });
  });

  it("rejects an out-of-scope file with a failed message", () => {
    const { body } = poll(streamWatchEvents as Handler, { file: "/etc/passwd.jsonl", poll: "1" });
    expect(body.messages).toEqual([{ event: "failed", data: { message: "unknown or out-of-scope transcript file" } }]);
  });
});

describe("watch artifact stream ?poll=1", () => {
  it("returns transcript-driven artifact versions past the after cursor", () => {
    const artFile = join(home, ".claude", "projects", "p", "claude-art.jsonl");
    writeFileSync(artFile, rec({
      type: "assistant", timestamp: "2026-07-03T10:00:00.000Z",
      message: { role: "assistant", content: [
        { type: "tool_use", id: "w1", name: "Write", input: { file_path: "/w/index.html", content: "<!doctype html><h1>v1</h1>" } },
      ] },
    }) + "\n");

    const first = poll(streamWatch as Handler, { file: artFile, poll: "1", after: "0", since: "0" });
    expect(first.body.messages[0]).toMatchObject({ event: "phase", data: { phase: "watching", mode: "transcript" } });
    const arts = first.body.messages.filter((m) => m.event === "artifact");
    expect(arts.length).toBe(1);
    expect(arts[0].data).toMatchObject({ index: 0, name: "index.html", html: expect.stringContaining("v1") });
    const after = first.body.cursor.after as number;
    expect(after).toBe(1);

    // Nothing new → no artifact messages, cursor unchanged.
    const second = poll(streamWatch as Handler, { file: artFile, poll: "1", after: String(after), since: "0" });
    expect(second.body.messages.filter((m) => m.event === "artifact")).toEqual([]);
    expect(second.body.cursor.after).toBe(1);
  });
});

describe("watch SSE heartbeat", () => {
  it("is a named ping event, observable by EventSource", () => {
    vi.useFakeTimers();
    let buf = "";
    const res = { writeHead() {}, write(c: string) { buf += c; }, end() {} };
    streamWatchEvents({ query: { file: claudeFile }, on() {} } as never, res as never);
    vi.advanceTimersByTime(15_000);
    expect(buf).toContain("event: ping\n");
    expect(buf).not.toMatch(/^: ping$/m); // the old comment form, invisible to EventSource
  });
});
