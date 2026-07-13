import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Analyze } from "./Analyze.js";

afterEach(cleanup);

// JSON routes (testbed, report/runs) — the typed client reads .text().
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

// A text/event-stream Response of `data:` frames — the wire the streamOf route
// produces, consumed by @agentback/client's route.stream(). Frames are enqueued
// with a gap so React renders each intermediate state (delta) before the next.
function sseResponse(frames: unknown[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const f of frames) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        await new Promise((r) => setTimeout(r, 5));
      }
      ctrl.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const testbed = (u: string, projects: unknown[]) => {
  if (u.includes("/api/report/runs")) return res({ runs: [] });
  if (u.includes("/api/testbed/recents")) return res({ recents: [] });
  if (u.includes("/api/testbed/projects")) return res({ projects });
  return null;
};

describe("Analyze", () => {
  it("lists discovered projects and analyzes one in place, handing keys to onPick", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/workflow/analyze/stream")) return sseResponse([
        { type: "done", cached: false, candidates: [{ name: "Spec Loop", description: "", confidence: "high", include: [{ type: "skill", name: "brainstorming" }] }] },
      ]);
      const t = testbed(u, [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }]);
      if (t) return t;
      throw new Error("unexpected " + u);
    }));
    const picked: string[][] = [];
    render(<Analyze apiBase="" onPick={(k) => picked.push(k)} />);

    fireEvent.click(await screen.findByText("Analyze →"));
    fireEvent.click(await screen.findByText(/Use this selection/));
    expect(picked).toEqual([["skills::brainstorming"]]);
  });

  it("gives immediate feedback and streams the agent's output", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/workflow/analyze/stream")) return sseResponse([
        { type: "delta", text: "scanning sessions…" },
        { type: "done", cached: false, candidates: [] },
      ]);
      const t = testbed(u, [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }]);
      if (t) return t;
      throw new Error("unexpected " + u);
    }));
    render(<Analyze apiBase="" onPick={() => {}} />);
    fireEvent.click(await screen.findByText("Analyze →"));
    // Feedback appears once the run starts (after the hook's start-guard fetch).
    await waitFor(() => expect(screen.getAllByText("Analyzing…").length).toBeGreaterThanOrEqual(2));
    // agent tokens stream into a transcript, then the terminal report renders
    expect(await screen.findByText(/scanning sessions/)).toBeTruthy();
    expect(await screen.findByText(/No recurring workflow found/i)).toBeTruthy();
  });

  it("filters the project list by the search query", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      const t = testbed(u, [
        { path: "/home/me/alpha", flavor: "claude", lastUsed: null, exists: true },
        { path: "/home/me/beta", flavor: "claude", lastUsed: null, exists: true },
      ]);
      if (t) return t;
      throw new Error("unexpected " + u);
    }));
    render(<Analyze apiBase="" onPick={() => {}} />);
    expect(await screen.findByText(/alpha/)).toBeTruthy();
    expect(screen.getByText(/beta/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("search projects"), { target: { value: "alpha" } });
    await waitFor(() => expect(screen.queryByText(/beta/)).toBeNull());
    expect(screen.getByText(/alpha/)).toBeTruthy();
  });
});
