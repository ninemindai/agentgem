import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Analyze } from "./Analyze.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}

describe("Analyze", () => {
  it("lists discovered projects and analyzes one in place, handing keys to onPick", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/testbed/recents")) return res({ recents: [] });
      if (u.includes("/api/testbed/projects"))
        return res({ projects: [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }] });
      throw new Error("unexpected " + u);
    }));
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const picked: string[][] = [];
    render(<Analyze apiBase="" onPick={(k) => picked.push(k)} />);

    // the project list renders immediately (no disclosure); click the project's Analyze
    fireEvent.click(await screen.findByText("Analyze →"));
    FakeES.last!.emit("done", { cached: false, candidates: [
      { name: "Spec Loop", description: "", confidence: "high", include: [{ type: "skill", name: "brainstorming" }] },
    ] });
    fireEvent.click(await screen.findByText(/Use this selection/));
    expect(picked).toEqual([["skills::brainstorming"]]);
  });

  it("filters the project list by the search query", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/testbed/recents")) return res({ recents: [] });
      if (u.includes("/api/testbed/projects")) return res({ projects: [
        { path: "/home/me/alpha", flavor: "claude", lastUsed: null, exists: true },
        { path: "/home/me/beta", flavor: "claude", lastUsed: null, exists: true },
      ] });
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
