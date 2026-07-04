import { describe, it, expect } from "vitest";
import { renderDashboard, extractHtml, MAX_HTML, type RenderInput } from "@agentgem/insight";
import type { SessionEvent } from "@agentgem/insight";

// Like fakeConnect, but records the prompt the agent received (for asserting prompt content).
function capturingConnect(sink: { prompt: string }, reply = "<html><body>x</body></html>") {
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        promptText: async (p: string) => { sink.prompt = p; return reply; },
        dispose: () => {},
      }),
    },
    close: () => {},
  }) as never;
}

// A minimal fake ACP connect-fn: its agent returns whatever `reply` we pass, or throws.
function fakeConnect(reply: string | (() => Promise<string>)) {
  return async () => ({
    ctx: {
      open: async () => ({
        setMode: async () => {},
        promptText: async () => (typeof reply === "function" ? reply() : reply),
        dispose: () => {},
      }),
    },
    close: () => {},
  }) as never;
}

// SessionEvent is { tsMs, span } — `index` is added by the SSE layer, not part of the type (#2).
const ev = (): SessionEvent => ({ tsMs: 0, span: { kind: "message", role: "assistant", text: "hi" } });
const base = (over: Partial<RenderInput> = {}): RenderInput =>
  ({ prevHtml: "", deltaEvents: [ev()], meta: { project: "p", agent: "claude" }, ...over });

describe("extractHtml", () => {
  it("returns a bare document unchanged", () => {
    expect(extractHtml("<!doctype html><html><body>x</body></html>")).toContain("<body>x</body>");
  });
  it("unwraps a { html: … } wrapper", () => {
    expect(extractHtml('{"html":"<div>ok</div>"}')).toBe("<div>ok</div>");
  });
  it("rejects prose with no markup", () => {
    expect(extractHtml("I could not build a dashboard.")).toBeNull();
  });
});

describe("renderDashboard", () => {
  it("returns the agent HTML with ok:true on the first render", async () => {
    const r = await renderDashboard(base({ connectFn: fakeConnect("<html><body>dash</body></html>") }));
    expect(r.ok).toBe(true);
    expect(r.html).toContain("dash");
  });
  it("falls back to prevHtml with ok:false on non-markup output", async () => {
    const r = await renderDashboard(base({ prevHtml: "<html>PREV</html>", connectFn: fakeConnect("sorry, no") }));
    expect(r).toEqual({ html: "<html>PREV</html>", ok: false });
  });
  it("falls back on a throwing agent", async () => {
    const r = await renderDashboard(base({ prevHtml: "<b>PREV</b>", connectFn: fakeConnect(async () => { throw new Error("boom"); }) }));
    expect(r).toEqual({ html: "<b>PREV</b>", ok: false });
  });
  it("falls back to empty string on first-render failure", async () => {
    const r = await renderDashboard(base({ prevHtml: "", connectFn: fakeConnect("") }));
    expect(r).toEqual({ html: "", ok: false });
  });
  it("injects the session's project name and agent into the prompt (not a placeholder)", async () => {
    const sink = { prompt: "" };
    await renderDashboard(base({ meta: { project: "acme-web", agent: "claude" }, connectFn: capturingConnect(sink) }));
    expect(sink.prompt).toContain("acme-web");
    expect(sink.prompt).toContain("claude");
  });
  it("truncates HTML over MAX_HTML and flags it (drives the endpoint's full-regenerate)", async () => {
    const huge = "<html><body>" + "x".repeat(MAX_HTML + 10_000) + "</body></html>";
    const r = await renderDashboard(base({ connectFn: fakeConnect(huge) }));
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.html.length).toBe(MAX_HTML);
  });
});
