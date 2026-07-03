import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { Watch, sandboxDoc } from "../index.js";

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

describe("sandboxDoc", () => {
  it("injects a CSP meta into an existing <head>", () => {
    const out = sandboxDoc("<html><head><title>t</title></head><body>x</body></html>");
    expect(out).toContain("Content-Security-Policy");
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<title>"));
    expect(out).toContain("default-src 'none'");
  });
  it("wraps a bare fragment in a document with CSP", () => {
    const out = sandboxDoc("<h1>hi</h1>");
    expect(out).toMatch(/^<!doctype html>/i);
    expect(out).toContain("Content-Security-Policy");
    expect(out).toContain("<h1>hi</h1>");
  });
});

const SESSION = { id: "sess-1", file: "/w/.claude/projects/p/sess-1.jsonl", agent: "claude", project: "site", model: "claude-opus-4-8", msgs: 4, startMs: 0, endMs: 1, ageMs: 30000 };

describe("Watch panel", () => {
  it("lists sessions and streams an artifact into a sandboxed iframe on select", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [SESSION] }) })) as unknown as typeof fetch);

    render(<Watch apiBase="" />);
    const row = await screen.findByText("site");
    fireEvent.click(row);

    // stream opened for the picked file
    expect(FakeES.last!.url).toContain("sess-1.jsonl");
    FakeES.last!.emit("phase", { phase: "watching" });
    FakeES.last!.emit("artifact", { index: 0, path: "/w/site/index.html", name: "index.html", tool: "Write", version: 1, tsMs: 1, truncated: false, html: "<h1>live</h1>" });

    const frame = await screen.findByTitle("artifact preview") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>live</h1>");
    expect(frame.getAttribute("srcdoc")).toContain("Content-Security-Policy");
  });

  it("shows an empty state when no sessions are active", async () => {
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [] }) })) as unknown as typeof fetch);
    render(<Watch apiBase="" />);
    await waitFor(() => expect(screen.getByText(/No sessions active/)).toBeTruthy());
  });
});
