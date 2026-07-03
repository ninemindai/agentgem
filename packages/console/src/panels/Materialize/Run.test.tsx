import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Run } from "./Run.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(type: string, cb: (e: unknown) => void) { (this.listeners[type] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(type: string, data: unknown) { for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) }); }
}

describe("Run", () => {
  it("prepares, streams output, and reaches done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ runId: "r1", agent: "claude" })));
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);

    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("task"), { target: { value: "say hi" } });
    fireEvent.click(screen.getByText("Run"));

    // wait for prepare to resolve and the stream to open
    await waitFor(() => expect(FakeES.last).not.toBeNull());
    const es = FakeES.last!;
    es.emit("phase", { phase: "running", agent: "claude" });
    es.emit("delta", { text: "hello" });
    es.emit("tool", { name: "read_file" });
    es.emit("done", {});

    expect(await screen.findByText("hello")).toBeTruthy();
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(await screen.findByText("done")).toBeTruthy();
  });

  it("Run is disabled until a task is entered", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ runId: "r1", agent: "claude" })));
    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    expect((screen.getByText("Run") as HTMLButtonElement).disabled).toBe(true);
  });

  it("all-agents mode hides the task input, verifies, and renders per-agent blocks + matrix", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ verifyId: "v1", gemName: "gem", gemDigest: "sha:d", agents: ["claude", "codex"] })));
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);

    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("agent"), { target: { value: "all" } });
    expect(screen.queryByLabelText("task")).toBeNull();          // task hidden
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => expect(FakeES.last).not.toBeNull());
    const es = FakeES.last!;
    expect(es.url).toContain("/api/gem/verify/stream?verifyId=v1");
    es.emit("agent-start", { agent: "claude" });
    es.emit("delta", { agent: "claude", text: "hi from claude" });
    es.emit("tool", { agent: "claude", title: "Skill(qa)" });
    es.emit("verdict", { agent: "claude", status: "passed" });
    es.emit("agent-start", { agent: "codex" });
    es.emit("verdict", { agent: "codex", status: "unavailable", detail: "not installed" });
    es.emit("done", { verdicts: [
      { agent: "claude", status: "passed" },
      { agent: "codex", status: "unavailable", detail: "not installed" },
    ], gemName: "gem", gemDigest: "sha:d" });

    expect(await screen.findByText("hi from claude")).toBeTruthy();  // claude's block
    expect(screen.getByText("Skill(qa)")).toBeTruthy();
    // The matrix row is one joined string — match with regexes, not exact text.
    expect(await screen.findByText(/✓ claude/)).toBeTruthy();
    expect(screen.getByText(/– codex \(not installed\)/)).toBeTruthy();
  });

  it("all-agents prepare failure (contract-less) surfaces the 400 message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: "this Gem carries no contract" } }) }) as unknown as Response));
    render(<Run apiBase="" selection={{ skills: [] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("agent"), { target: { value: "all" } });
    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByText(/no contract/i)).toBeTruthy();
  });
});
