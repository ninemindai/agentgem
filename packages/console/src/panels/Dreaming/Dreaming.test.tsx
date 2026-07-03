import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { Dreaming } from "./index.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ""; });

const EVENTS = [
  { ts: 500, kind: "skill", title: "foo", detail: "does foo", status: "queued", phase: "LEARN", key: "k1", firstSeenMs: 500, root: "/p" },
  { ts: 400, kind: "verified", title: "qa-gem", detail: "all checks passed", agent: "claude", passed: true },
  { ts: 300, kind: "opportunity", title: "sess-1", detail: "ship it", status: "queued", key: "o1", firstSeenMs: 300, root: "/proj" },
  { ts: 200, kind: "pass", title: "dream pass #1", detail: "DEEP · +3 skills · +1 lessons · +0 opportunities" },
  { ts: 100, kind: "lesson", title: "use-pnpm", detail: "use pnpm", status: "dismissed", key: "k2", firstSeenMs: 50, root: "/p" },
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("/api/dream/status")) return new Response(JSON.stringify({ enabled: true, phasesLit: ["DEEP"], promoted: 2, queued: 2, lastPassAtMs: 1 }));
    if (url.includes("/api/journey")) {
      const kind = new URL(url, "http://x").searchParams.get("kind");
      const events = kind ? EVENTS.filter((e) => e.kind === kind) : EVENTS;
      return new Response(JSON.stringify({ events, truncated: false }));
    }
    return new Response(JSON.stringify({ ok: true }));
  }));
});

describe("Journey panel", () => {
  it("renders all event kinds on one timeline with the status strip", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => expect(screen.getByText("foo")).toBeTruthy());
    expect(screen.getByText("qa-gem")).toBeTruthy();       // verified
    expect(screen.getByText("dream pass #1")).toBeTruthy(); // pass
    expect(screen.getByText("use-pnpm")).toBeTruthy();      // dismissed lesson (history visible)
    expect(screen.getByText(/2 promoted/i)).toBeTruthy();   // status strip intact
    expect(screen.getByText("LEARN")).toBeTruthy();          // phase badge
  });

  it("filter chips refetch with ?kind=", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getByRole("button", { name: /^verified$/i }));
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("/api/journey?kind=verified"))).toBe(true));
  });

  it("accept posts to the accept endpoint for a queued skill", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("foo"));
    fireEvent.click(screen.getAllByRole("button", { name: /^accept$/i })[0]);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).endsWith("/api/dream/queue/accept"))).toBe(true));
  });

  it("reviewed events show status and no action buttons", async () => {
    render(<Dreaming apiBase="" />);
    await waitFor(() => screen.getByText("use-pnpm"));
    expect(screen.getByText("dismissed")).toBeTruthy();
    // one queued skill + one queued opportunity → exactly 1 Accept and 2 Dismiss buttons
    expect(screen.getAllByRole("button", { name: /^accept$/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^dismiss$/i })).toHaveLength(2);
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
      if (url.includes("/api/journey")) return new Response(JSON.stringify({ events: [], truncated: false }));
      return new Response(JSON.stringify({ ok: true }));
    }));
    render(<Dreaming apiBase="" />);
    fireEvent.click(await screen.findByRole("button", { name: "Dream now" }));
    await waitFor(() => expect(screen.getByText(/Dream pass complete/i)).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByRole("button", { name: "Dream now" })).toBeTruthy(); // re-enabled, no longer "Dreaming…"
  });
});
