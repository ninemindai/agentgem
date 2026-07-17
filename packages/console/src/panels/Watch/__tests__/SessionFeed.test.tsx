import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { toTurns, SessionFeed } from "../SessionFeed.js";
import type { FeedEvent, FeedSpan } from "../eventStream.js";

const ev = (index: number, span: FeedSpan): FeedEvent => ({ index, tsMs: 0, span });
const toolSpans = (t: ReturnType<typeof toTurns>[number]) =>
  t.spans.filter((s) => s.kind === "tool_call") as Extract<(typeof t.spans)[number], { kind: "tool_call" }>[];

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

describe("toTurns", () => {
  it("gives each message its own turn and attaches tool calls to the current assistant turn", () => {
    const turns = toTurns([
      ev(0, { kind: "message", role: "user", text: "hi" }),
      ev(1, { kind: "message", role: "assistant", text: "running ls" }),
      ev(2, { kind: "tool_call", toolId: "t1", name: "Bash", input: "{}" }),
    ]);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1].spans.map((s) => s.kind)).toEqual(["message", "tool_call"]);
  });

  it("pairs a tool_result onto its tool_call by toolId (output lands on the call span)", () => {
    const turns = toTurns([
      ev(0, { kind: "message", role: "assistant", text: "on it" }),
      ev(1, { kind: "tool_call", toolId: "t1", name: "Bash", input: "{}" }),
      ev(2, { kind: "tool_result", toolId: "t1", output: "ok", error: false }),
    ]);
    expect(turns).toHaveLength(1);
    expect(toolSpans(turns[0])[0]).toMatchObject({ name: "Bash", output: "ok", error: false });
  });

  it("starts a synthetic assistant turn for a tool_call with no preceding assistant message", () => {
    const turns = toTurns([ev(3, { kind: "tool_call", toolId: "t1", name: "Read", input: "{}" })]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("assistant");
    expect(toolSpans(turns[0])[0].name).toBe("Read");
  });

  it("a user message closes the assistant turn, so a later tool_call opens a fresh one", () => {
    const turns = toTurns([
      ev(0, { kind: "message", role: "assistant", text: "a" }),
      ev(1, { kind: "message", role: "user", text: "b" }),
      ev(2, { kind: "tool_call", toolId: "t1", name: "Bash", input: "{}" }),
    ]);
    expect(turns.map((t) => t.role)).toEqual(["assistant", "user", "assistant"]);
  });

  it("keeps an orphan tool_result (no matching call) visible as its own span", () => {
    const turns = toTurns([ev(2, { kind: "tool_result", toolId: "tX", output: "?", error: true })]);
    expect(turns).toHaveLength(1);
    expect(toolSpans(turns[0])[0]).toMatchObject({ output: "?", error: true });
  });

  it("keeps concurrent calls independent by toolId", () => {
    const turns = toTurns([
      ev(0, { kind: "tool_call", toolId: "a", name: "Read", input: "{}" }),
      ev(1, { kind: "tool_call", toolId: "b", name: "Bash", input: "{}" }),
      ev(2, { kind: "tool_result", toolId: "b", output: "B", error: false }),
      ev(3, { kind: "tool_result", toolId: "a", output: "A", error: false }),
    ]);
    const spans = toolSpans(turns[0]);
    expect(spans.map((s) => s.name)).toEqual(["Read", "Bash"]);
    expect(spans[0].output).toBe("A");
    expect(spans[1].output).toBe("B");
  });
});

describe("SessionFeed", () => {
  it("streams events into the turn tree and pairs a live tool_call with its later result", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<SessionFeed apiBase="" file="/w/.claude/projects/p/s.jsonl" />);

    expect(FakeES.last!.url).toContain("/api/watch/events");
    expect(FakeES.last!.url).toContain("s.jsonl");

    FakeES.last!.emit("phase", { phase: "watching", agent: "claude" });
    FakeES.last!.emit("event", ev(0, { kind: "message", role: "assistant", text: "running ls" }));
    FakeES.last!.emit("event", ev(1, { kind: "tool_call", toolId: "t1", name: "Bash", input: '{"command":"ls"}' }));

    // turns render expanded by default, so the message body and the live tool call
    // are visible without any clicks ("running ls" shows in both the turn summary
    // and the verbatim message body)
    expect((await screen.findAllByText("running ls")).length).toBeGreaterThan(0);
    // turn-tree UI, not the old flat cards: a collapsible turn header with the
    // role + relative offset from the session start
    expect(screen.getByRole("button", { name: /assistant/ })).toBeTruthy();
    expect(screen.getByText("+0s")).toBeTruthy();
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();      // headline pulled from the command arg
    expect(screen.getByText("running")).toBeTruthy(); // pending until the result lands

    FakeES.last!.emit("event", ev(2, { kind: "tool_result", toolId: "t1", output: "a.ts b.ts", error: false }));
    // a running tool call mounts open, so its output appears as soon as it lands
    expect(await screen.findByText("a.ts b.ts")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
  });
});
