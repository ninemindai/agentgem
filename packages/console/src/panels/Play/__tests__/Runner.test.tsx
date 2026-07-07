// packages/console/src/panels/Play/__tests__/Runner.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { Runner } from "../Runner.js";
import { playSessionDataRoute, inventoryRoute } from "../../../api/routes.js";
import { getConsent } from "../consent.js";
import * as watchStream from "../../Watch/watchStream.js";
import * as studioStream from "../studioStream.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* ignore */ } });

describe("Runner", () => {
  it("renders a sealed iframe (allow-scripts, no allow-same-origin) with the html in srcDoc", () => {
    const { container } = render(<Runner html="<h1>hi there</h1>" />);
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts"); // sealed: scripts run, but null-origin
    expect(iframe.getAttribute("srcdoc")).toContain("<h1>hi there</h1>");
  });

  it("renders the game at a full-window virtual viewport (scaled to fit, not clipped)", () => {
    const { container } = render(<Runner html="<p>x</p>" vw={1200} vh={780} />);
    const iframe = container.querySelector("iframe") as HTMLIFrameElement;
    // The iframe itself is sized to the virtual window; a CSS transform scales it down to the container.
    expect(iframe.style.width).toBe("1200px");
    expect(iframe.style.height).toBe("780px");
    expect(iframe.style.transform).toContain("scale(");
  });

  // jsdom's MessageEvent constructor drops `source`, so set it explicitly to emulate a message from the iframe.
  const fromIframe = (win: Window, data: unknown) => {
    const ev = new MessageEvent("message", { data });
    Object.defineProperty(ev, "source", { value: win });
    window.dispatchEvent(ev);
  };

  it("brokers session-data: on the iframe's request it fetches host data and feeds it back", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: { project: "p" }, timeline: [{ role: "user", tsMs: 1, text: "hi" }] });
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "session-data" });
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "agentgem:feed", channel: "session-data" }), "*"));
  });

  it("ignores a request for a capability the gem did NOT declare", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    fromIframe(win, { type: "agentgem:request", want: "invoke-agent" });
    await new Promise((r) => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled(); // want ∉ needs
  });

  it("a gated capability PROMPTS for consent and does NOT feed until allowed; Allow feeds + remembers", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [{ name: "brainstorming" }], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g2" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "local-project-access" });
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy()); // consent prompt shown
    expect(inv).not.toHaveBeenCalled();                                   // NOT fetched before consent
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(inv).toHaveBeenCalled());                  // now brokered
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "agentgem:feed", channel: "local-project-access" }), "*"));
    expect(getConsent("g2", "local-project-access")).toBe("granted");     // remembered
  });

  it("Deny records the choice and never feeds", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g3" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    fromIframe(win, { type: "agentgem:request", want: "local-project-access" });
    await waitFor(() => expect(screen.getByText("Deny")).toBeTruthy());
    fireEvent.click(screen.getByText("Deny"));
    await new Promise((r) => setTimeout(r, 20));
    expect(inv).not.toHaveBeenCalled();
    expect(getConsent("g3", "local-project-access")).toBe("denied");
  });

  it("live-session-events: after consent, streams the latest session's events into the game", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([
      { id: "s", file: "/f.jsonl", agent: "claude", project: null, model: null, msgs: 1, startMs: 0, endMs: 0, ageMs: 0 },
    ]);
    let emit: (e: unknown) => void = () => {};
    vi.spyOn(watchStream, "openWatchStream").mockImplementation((_a, _f, cb) => { emit = cb as (e: unknown) => void; return () => {}; });
    const { container } = render(<Runner html="<p>x</p>" name="w1" apiBase="" needs={["live-session-events"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "live-session-events" });
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(watchStream.openWatchStream).toHaveBeenCalledWith("", "/f.jsonl", expect.any(Function)));
    emit({ type: "event", index: 0 }); // a live session event arrives
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "agentgem:feed", channel: "live-session-events" }), "*");
  });

  it("live-session-events: a no-session request posts idle but does NOT wedge a later retry", async () => {
    const fs = vi.spyOn(watchStream, "fetchSessions").mockResolvedValueOnce([]); // no sessions yet
    vi.spyOn(watchStream, "openWatchStream").mockImplementation(() => () => {});
    const { container } = render(<Runner html="<p>x</p>" name="w2" apiBase="" needs={["live-session-events"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "live-session-events" });
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ channel: "live-session-events", data: { type: "idle" } }), "*"));
    // a session now exists; the game re-requests (consent remembered) → the guard must have been released
    fs.mockResolvedValue([{ id: "s", file: "/late.jsonl", agent: "claude", project: null, model: null, msgs: 1, startMs: 0, endMs: 0, ageMs: 0 }]);
    fromIframe(win, { type: "agentgem:request", want: "live-session-events" });
    await waitFor(() => expect(watchStream.openWatchStream).toHaveBeenCalledWith("", "/late.jsonl", expect.any(Function)));
  });

  it("invoke-agent: after consent, runs an agent turn and streams the transcript back", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/agents") ? { ok: true, json: async () => ({ agents: [{ id: "claude", available: true }] }) }
        : { ok: true, json: async () => ({ chatId: "c1" }) }) as unknown as typeof fetch);
    let onDelta: ((t: string) => void) | null = null;
    vi.spyOn(studioStream, "openStudioStream").mockImplementation((_a, _c, _m, h) => { onDelta = h.onDelta; return () => {}; });
    const { container } = render(<Runner html="<p>x</p>" name="a1" apiBase="" needs={["invoke-agent"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    fromIframe(win, { type: "agentgem:request", want: "invoke-agent", message: "hello agent" });
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(studioStream.openStudioStream).toHaveBeenCalledWith("", "c1", "hello agent", expect.anything()));
    onDelta!("hi there");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "agentgem:feed", channel: "invoke-agent", data: { kind: "delta", text: "hi there" } }), "*");
    vi.unstubAllGlobals();
  });

  it("a thumbnail (interactive=false) never prompts for a gated capability", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" interactive={false} name="g4" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    fromIframe(win, { type: "agentgem:request", want: "local-project-access" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Allow")).toBeNull(); // no prompt on a thumbnail
    expect(inv).not.toHaveBeenCalled();
  });
});
