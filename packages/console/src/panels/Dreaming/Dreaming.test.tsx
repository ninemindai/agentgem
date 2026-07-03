import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Dreaming } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 1, lastPassAtMs: 1 }));
    if (url.endsWith("/api/dream/queue")) return new Response(JSON.stringify({ items: [
      { key: "k1", kind: "skill", root: "/p", name: "foo", summary: "does foo" },
      { key: "o1", kind: "opportunity", root: "/proj", name: "sess-1", summary: "ship it" },
    ] }));
    if (url.endsWith("/api/dream/diary")) return new Response(JSON.stringify({ entries: [{ atMs: 1, passId: 1, rootsProcessed: ["/p"], phasesLit: ["DEEP"], enqueued: { skills: 3, lessons: 1 }, degraded: false }] }));
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Dreaming panel", () => {
  it("renders the phase readout, promoted count, and a queued draft", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("foo")).toBeTruthy());
    expect(screen.getByText(/2 promoted/i)).toBeTruthy();
    expect(screen.getByText("DEEP")).toBeTruthy();
  });

  it("accept posts to the accept endpoint", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /accept/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).endsWith("/api/dream/queue/accept"))).toBe(true));
  });

  it("shows pass history in the Diary tab", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /diary/i }));
    await waitFor(() => expect(screen.getByText(/\+3 skills · \+1 lessons/)).toBeTruthy());
  });

  it("opportunity 'Publish →' routes into Curate", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("ship it"));
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));
    await waitFor(() => expect(window.location.hash).toBe("#/curate"));
  });

  it("gives immediate 'Dreaming…' feedback and hits the run endpoint on Dream now", async () => {
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    // pending state is shown synchronously — the reported bug was zero feedback here
    const pending = await screen.findByRole("button", { name: /dreaming/i });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some(
      (c) => String(c[0]).endsWith("/api/dream/run") && (c[1] as RequestInit | undefined)?.method === "POST")).toBe(true));
  });

  it("polls until a new pass lands, shows a 'complete' note, and re-enables the button", async () => {
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 1, lastPassAtMs: ++statusCalls }));
      if (url.endsWith("/api/dream/queue")) return new Response(JSON.stringify({ items: [] }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    await waitFor(() => expect(screen.getByText(/Dream pass complete/i)).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Dream now" })).toBeTruthy(); // re-enabled, no longer "Dreaming…"
  });
});
