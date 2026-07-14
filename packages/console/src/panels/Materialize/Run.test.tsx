import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Run } from "./Run.js";

afterEach(cleanup);

// Prepare (POST) returns JSON via .text(); the stream (GET) returns a real
// text/event-stream Response consumed by @agentback/client's route.stream().
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
function sseResponse(frames: unknown[]): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("Run", () => {
  it("prepares, streams output, and reaches done", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/gem/run/stream")) return sseResponse([
        { type: "phase", phase: "running", agent: "claude" },
        { type: "delta", text: "hello" },
        { type: "tool", tool: { name: "read_file" } },
        { type: "done", result: {} },
      ]);
      return res({ runId: "r1", agent: "claude" });
    }));

    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("task"), { target: { value: "say hi" } });
    fireEvent.click(screen.getByText("Run"));

    expect(await screen.findByText("hello")).toBeTruthy();
    expect(await screen.findByText("read_file")).toBeTruthy();
    expect(await screen.findByText("done")).toBeTruthy();
  });

  it("Run is disabled until a task is entered", () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ runId: "r1", agent: "claude" })));
    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    expect((screen.getByText("Run") as HTMLButtonElement).disabled).toBe(true);
  });

  it("all-agents mode hides the task input, verifies, and renders per-agent blocks + matrix", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/gem/verify/stream")) return sseResponse([
        { type: "agent-start", agent: "claude" },
        { type: "delta", agent: "claude", text: "hi from claude" },
        { type: "tool", agent: "claude", tool: { title: "Skill(qa)" } },
        { type: "verdict", verdict: { agent: "claude", status: "passed" } },
        { type: "agent-start", agent: "codex" },
        { type: "verdict", verdict: { agent: "codex", status: "unavailable", detail: "not installed" } },
        { type: "done", verdicts: [
          { agent: "claude", status: "passed" },
          { agent: "codex", status: "unavailable", detail: "not installed" },
        ], gemName: "gem", gemDigest: "sha:d" },
      ]);
      return res({ verifyId: "v1", gemName: "gem", gemDigest: "sha:d", agents: ["claude", "codex"] });
    }));

    render(<Run apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    fireEvent.change(screen.getByLabelText("agent"), { target: { value: "all" } });
    expect(screen.queryByLabelText("task")).toBeNull();          // task hidden
    fireEvent.click(screen.getByText("Verify"));

    expect(await screen.findByText("hi from claude")).toBeTruthy();  // claude's block
    expect(await screen.findByText("Skill(qa)")).toBeTruthy();
    // The matrix row is one joined string — match with regexes, not exact text.
    expect(await screen.findByText(/✓ claude/)).toBeTruthy();
    expect(await screen.findByText(/– codex \(not installed\)/)).toBeTruthy();
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
