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
});
