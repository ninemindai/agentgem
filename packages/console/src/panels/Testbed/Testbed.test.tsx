import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Testbed } from "./index.js";
import { takeRecommendedSelection } from "../../recommendation.js";

afterEach(cleanup);

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() { this.closed = true; }
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/testbed/recents"))
      return res({ recents: [{ path: "/home/me/proj", flavor: "claude", name: "My Testbed", lastUsed: "2026-01-01", exists: true }] });
    if (u.includes("/api/testbed/projects"))
      return res({ projects: [{ path: "/home/me/repo-a", flavor: "claude", lastUsed: null, exists: true }] });
    if (u.includes("/api/testbed/scaffold"))
      return res({ root: "/tmp/new-tb", created: ["CLAUDE.md", ".claude/"] });
    throw new Error(`unexpected ${u}`);
  });
}

describe("Testbed", () => {
  it("lists recents and discovered projects", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Testbed apiBase="" />);
    expect(await screen.findByText("My Testbed")).toBeTruthy();
    expect(await screen.findByText(/repo-a/)).toBeTruthy();
  });

  it("scaffolds a new testbed", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Testbed apiBase="" />);
    await screen.findByText("My Testbed");
    fireEvent.change(screen.getByLabelText("testbed name"), { target: { value: "demo" } });
    fireEvent.change(screen.getByLabelText("testbed root"), { target: { value: "/tmp/new-tb" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(screen.getByText(/created testbed at \/tmp\/new-tb/)).toBeTruthy());
  });

  it("analyzes and hands the chosen candidate's selection to the Ledger", async () => {
    vi.stubGlobal("fetch", mockFetch());
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    window.location.hash = "";
    render(<Testbed apiBase="" />);
    await screen.findByText("My Testbed");

    fireEvent.change(screen.getByLabelText("analyze root"), { target: { value: "/home/me/repo-a" } });
    fireEvent.click(screen.getByText("Analyze"));
    FakeES.last!.emit("done", {
      cached: false,
      candidates: [{ name: "Spec Loop", description: "the build loop", confidence: "high",
        include: [{ type: "skill", name: "brainstorming" }, { type: "skill", name: "writing-plans" }] }],
    });

    expect(await screen.findByText("Spec Loop")).toBeTruthy();
    fireEvent.click(screen.getByText(/Use this selection/));
    expect(window.location.hash).toBe("#/ledger");
    expect(takeRecommendedSelection()).toEqual(["skills::brainstorming", "skills::writing-plans"]);
  });
});
