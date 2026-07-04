import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Dashboard } from "../Dashboard.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; vi.unstubAllGlobals(); });

const frames = () => Array.from(document.querySelectorAll("iframe")) as HTMLIFrameElement[];

describe("Dashboard", () => {
  it("opens the dashboard stream for the file", () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/.claude/projects/p/s.jsonl" />);
    expect(FakeES.last!.url).toContain("/api/watch/dashboard");
    expect(FakeES.last!.url).toContain("s.jsonl");
  });

  it("first render lands HTML in a sandboxed iframe; a11y region announces it", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    // A `rendering` burst must have fired before the "building" copy applies (quiet-session
    // vs. waiting-for-first-render is disambiguated by that signal — see other tests below).
    FakeES.last!.emit("rendering", {});
    await waitFor(() => expect(screen.getByText(/Reading the session/i)).toBeTruthy());
    FakeES.last!.emit("render", { html: "<h1>alpha</h1>", version: 1 });
    // FakeES.emit() calls listeners directly (no DOM event, no act()) — React 19's scheduler
    // needs a macrotask to flush the resulting state update, so wait for it like every other
    // EventSource-mock test in this package (Watch.test.tsx, SessionFeed.test.tsx, Run.test.tsx).
    await waitFor(() => expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("alpha"))).toBe(true));
    const visible = frames().find((f) => f.getAttribute("srcdoc")?.includes("alpha"))!;
    expect(visible.getAttribute("sandbox")).toBe("allow-scripts");
    expect(screen.getByRole("status").textContent).toMatch(/updated/i);
  });

  it("double-buffers: second render writes the OTHER iframe and visibility flips to it on load", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("render", { html: "<h1>one</h1>", version: 1 });
    await waitFor(() => expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("one"))).toBe(true));
    // Deterministically fire iframe load so the refs advance regardless of jsdom's own
    // (version-dependent, async) auto-fire — makes the double-buffer flip explicit (eng-review Q1/#9).
    fireEvent.load(frames().find((f) => f.getAttribute("srcdoc")?.includes("one"))!); // buffer 0 paints → visible 0
    FakeES.last!.emit("render", { html: "<h1>two</h1>", version: 2 });
    await waitFor(() => expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("two"))).toBe(true));
    const one = frames().find((f) => f.getAttribute("srcdoc")?.includes("one"))!;
    const two = frames().find((f) => f.getAttribute("srcdoc")?.includes("two"))!;
    expect(one).toBeTruthy(); expect(two).toBeTruthy(); expect(one).not.toBe(two); // both buffers retained
    fireEvent.load(two);                                                            // buffer 1 paints → flip
    expect(two.className).toContain("is-visible");
    expect(one.className).not.toContain("is-visible");
    expect(frames().filter((f) => f.className.includes("is-visible"))).toHaveLength(1); // exactly one visible
  });

  it("keeps the last render and shows a note on failure", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("render", { html: "<h1>good</h1>", version: 1 });
    await waitFor(() => expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("good"))).toBe(true));
    FakeES.last!.emit("failed", { message: "render failed" });
    await waitFor(() => expect(screen.getByText(/showing last render/i)).toBeTruthy());
    expect(frames().some((f) => f.getAttribute("srcdoc")?.includes("good"))).toBe(true);
  });

  it("quiet session: a phase event with no rendering/render shows the quiet-session copy, not the building copy", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("phase", { phase: "idle", agent: "claude" });
    await waitFor(() => expect(screen.getByText(/Quiet session/i)).toBeTruthy());
    expect(screen.queryByText(/Reading the session/i)).toBeNull();
  });

  it("a rendering event (still no render) switches from quiet-session copy to the building copy", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    expect(screen.getByText(/Quiet session/i)).toBeTruthy();
    FakeES.last!.emit("rendering", {});
    await waitFor(() => expect(screen.getByText(/Reading the session/i)).toBeTruthy());
    expect(screen.queryByText(/Quiet session/i)).toBeNull();
  });

  it("first-render failure shows the couldn't-render-yet state instead of leaving the waiting copy stuck", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    render(<Dashboard apiBase="" file="/w/s.jsonl" />);
    FakeES.last!.emit("rendering", {});
    await waitFor(() => expect(screen.getByText(/Reading the session/i)).toBeTruthy());
    FakeES.last!.emit("failed", { message: "render failed" });
    await waitFor(() => expect(screen.getByText(/couldn't render yet/i)).toBeTruthy());
    expect(screen.queryByText(/Reading the session/i)).toBeNull();
    expect(screen.queryByText(/showing last render/i)).toBeNull();
  });
});
