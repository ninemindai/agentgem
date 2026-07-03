import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { toItems, SessionFeed, type FeedItem } from "../SessionFeed.js";
import type { FeedEvent, FeedSpan } from "../eventStream.js";

const ev = (index: number, span: FeedSpan): FeedEvent => ({ index, tsMs: 0, span });
const tool = (i: FeedItem) => i as Extract<FeedItem, { kind: "tool" }>;

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
}

afterEach(() => { cleanup(); FakeES.last = null; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("toItems", () => {
  it("merges a tool_result into its tool_call by toolId (one card, not two)", () => {
    const items = toItems([
      ev(0, { kind: "message", role: "user", text: "hi" }),
      ev(1, { kind: "tool_call", toolId: "t1", name: "Bash", input: "{}" }),
      ev(2, { kind: "tool_result", toolId: "t1", output: "ok", error: false }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["message", "tool"]);
    expect(tool(items[1])).toMatchObject({ name: "Bash", output: "ok", error: false, done: true });
  });

  it("keeps a tool_call pending (no output, not done) until its result arrives", () => {
    const items = toItems([ev(1, { kind: "tool_call", toolId: "t1", name: "Bash", input: "{}" })]);
    expect(items).toHaveLength(1);
    expect(tool(items[0]).done).toBe(false);
    expect(tool(items[0]).output).toBeUndefined();
  });

  it("renders an orphan tool_result (no matching call) as its own card", () => {
    const items = toItems([ev(2, { kind: "tool_result", toolId: "tX", output: "?", error: true })]);
    expect(items).toHaveLength(1);
    expect(tool(items[0])).toMatchObject({ done: true, error: true, output: "?" });
  });

  it("preserves order and keeps concurrent calls independent by toolId", () => {
    const items = toItems([
      ev(0, { kind: "tool_call", toolId: "a", name: "Read", input: "{}" }),
      ev(1, { kind: "tool_call", toolId: "b", name: "Bash", input: "{}" }),
      ev(2, { kind: "tool_result", toolId: "b", output: "B", error: false }),
      ev(3, { kind: "tool_result", toolId: "a", output: "A", error: false }),
    ]);
    expect(items.map((i) => tool(i).name)).toEqual(["Read", "Bash"]);
    expect(tool(items[0]).output).toBe("A"); // Read (a) paired with the later A result
    expect(tool(items[1]).output).toBe("B");
  });
});

describe("SessionFeed", () => {
  it("streams events and pairs a live tool_call with its later tool_result", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<SessionFeed apiBase="" file="/w/.claude/projects/p/s.jsonl" />);

    expect(FakeES.last!.url).toContain("/api/watch/events");
    expect(FakeES.last!.url).toContain("s.jsonl");

    FakeES.last!.emit("phase", { phase: "watching", agent: "claude" });
    FakeES.last!.emit("event", ev(0, { kind: "message", role: "assistant", text: "running ls" }));
    FakeES.last!.emit("event", ev(1, { kind: "tool_call", toolId: "t1", name: "Bash", input: '{"command":"ls"}' }));

    expect(await screen.findByText("running ls")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();     // headline pulled from the command arg
    expect(screen.getByText("running")).toBeTruthy(); // pending until the result lands

    FakeES.last!.emit("event", ev(2, { kind: "tool_result", toolId: "t1", output: "a.ts b.ts", error: false }));
    expect(await screen.findByText("a.ts b.ts")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });
});
