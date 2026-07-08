// packages/console/src/panels/Play/__tests__/Runner.test.tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { Runner } from "../Runner.js";
import { playSessionDataRoute, inventoryRoute } from "../../../api/routes.js";
import { getConsent } from "../consent.js";
import * as watchStream from "../../Watch/watchStream.js";
import * as studioStream from "../studioStream.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); try { localStorage.clear(); } catch { /* ignore */ } });

// jsdom's MessageEvent constructor drops `source`, so set it explicitly to emulate a message from the iframe.
const fromIframe = (win: Window, data: unknown) => {
  const ev = new MessageEvent("message", { data });
  Object.defineProperty(ev, "source", { value: win });
  window.dispatchEvent(ev);
};

// The sealed miniapp now speaks MCP Apps `ui/*` JSON-RPC (via the mcpAppClient shim) instead of the old
// private `agentgem:request`/`agentgem:feed` bridge: it `ui/initialize`s once, then drives `tools/call`s;
// the host replies (one-shot caps) or pushes `ui/notifications/tool-result` chunks (streaming caps).
let rpcId = 1;
const initialize = (win: Window): number => { const id = rpcId++; fromIframe(win, { jsonrpc: "2.0", id, method: "ui/initialize" }); return id; };
const callTool = (win: Window, name: string, args?: Record<string, unknown>): number => {
  const id = rpcId++;
  fromIframe(win, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args ?? {} } });
  return id;
};

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

  it("brokers session-data: on the iframe's tools/call it fetches host data and replies over the wire", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: { project: "p" }, timeline: [{ role: "user", tsMs: 1, text: "hi" }] });
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    initialize(win); // handshake first, exactly as the embedded shim does
    const id = callTool(win, "agentgem_get_session_data"); // AUTO cap — no consent prompt
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id, result: expect.objectContaining({ meta: { project: "p" } }) }), "*"));
  });

  it("ignores a tools/call for a capability the gem did NOT declare", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g1" apiBase="" needs={["session-data"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    callTool(win, "agentgem_get_inventory"); // local-project-access ∉ needs
    await new Promise((r) => setTimeout(r, 20));
    expect(inv).not.toHaveBeenCalled();       // cap not permitted → nothing brokered
    expect(screen.queryByText("Allow")).toBeNull(); // and no consent prompt for an undeclared cap
  });

  it("a gated capability PROMPTS for consent and does NOT feed until allowed; Allow feeds + remembers", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [{ name: "brainstorming" }], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g2" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    const id = callTool(win, "agentgem_get_inventory");
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy()); // consent prompt shown
    expect(inv).not.toHaveBeenCalled();                                   // NOT fetched before consent
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(inv).toHaveBeenCalled());                  // now brokered
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id, result: expect.objectContaining({ skills: [{ name: "brainstorming" }] }) }), "*")); // fed back over the wire
    expect(getConsent("g2", "local-project-access")).toBe("granted");     // remembered
  });

  it("Deny records the choice and never feeds", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g3" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    callTool(win, "agentgem_get_inventory");
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
    callTool(win, "agentgem_subscribe_sessions");
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(watchStream.openWatchStream).toHaveBeenCalledWith("", "/f.jsonl", expect.any(Function)));
    emit({ type: "event", index: 0 }); // a live session event arrives
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ method: "ui/notifications/tool-result", params: { toolName: "agentgem_subscribe_sessions", chunk: { type: "event", index: 0 } } }), "*");
  });

  it("live-session-events: a no-session request replies idle but does NOT wedge a later retry", async () => {
    const fs = vi.spyOn(watchStream, "fetchSessions").mockResolvedValueOnce([]); // no sessions yet
    vi.spyOn(watchStream, "openWatchStream").mockImplementation(() => () => {});
    const { container } = render(<Runner html="<p>x</p>" name="w2" apiBase="" needs={["live-session-events"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});
    const id = callTool(win, "agentgem_subscribe_sessions");
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id, result: { status: "idle" } }), "*"));
    // a session now exists; the game re-requests (consent remembered) → the guard must have been released
    fs.mockResolvedValue([{ id: "s", file: "/late.jsonl", agent: "claude", project: null, model: null, msgs: 1, startMs: 0, endMs: 0, ageMs: 0 }]);
    callTool(win, "agentgem_subscribe_sessions"); // consent granted → no second prompt
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
    callTool(win, "agentgem_invoke_agent", { message: "hello agent" });
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(studioStream.openStudioStream).toHaveBeenCalledWith("", "c1", "hello agent", expect.anything()));
    onDelta!("hi there");
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ method: "ui/notifications/tool-result", params: { toolName: "agentgem_invoke_agent", chunk: { kind: "delta", text: "hi there" } } }), "*");
    vi.unstubAllGlobals();
  });

  it("a thumbnail (interactive=false) never prompts for a gated capability", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" interactive={false} name="g4" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    callTool(win, "agentgem_get_inventory");
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Allow")).toBeNull(); // no prompt on a thumbnail
    expect(inv).not.toHaveBeenCalled();
  });

  it("a second gated-cap request while a prompt is open replaces the prompt without orphaning the first promise", async () => {
    const inv = vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [{ name: "test" }], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const { container } = render(<Runner html="<p>x</p>" name="g5" apiBase="" needs={["local-project-access"]} />);
    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    const post = vi.spyOn(win, "postMessage").mockImplementation(() => {});

    // Fire the first gated request — consent prompt shown
    const id1 = callTool(win, "agentgem_get_inventory");
    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());
    expect(inv).not.toHaveBeenCalled();

    // Fire a second gated request before resolving the first
    const id2 = callTool(win, "agentgem_get_inventory");
    await new Promise((r) => setTimeout(r, 10)); // let the component state settle

    // The prompt should still be visible (not stacked)
    expect(screen.queryAllByText("Allow").length).toBe(1);

    // Allow should resolve the second (current) request; the first was superseded and resolved as false
    fireEvent.click(screen.getByText("Allow"));
    await waitFor(() => expect(inv).toHaveBeenCalled());

    // The response to the second request should be posted
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ id: id2, result: expect.objectContaining({ skills: [{ name: "test" }] }) }), "*"));
  });
});

describe("Runner — Replay yours picker", () => {
  const sessions = [
    { id: "mine-1", file: "/f1", agent: "codex", project: "app", model: "gpt", msgs: 12, startMs: 0, endMs: 1, ageMs: 1 },
    { id: "mine-2", file: "/f2", agent: "claude", project: "lib", model: "opus", msgs: 5, startMs: 0, endMs: 1, ageMs: 1 },
  ];
  const html = "<!doctype html><body><div id=\"app\"></div></body>";

  it("offers the picker for an interactive session-data miniapp and feeds the chosen session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/watch/sessions")) return { ok: true, json: async () => ({ sessions }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    const data = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [{ role: "user", tsMs: 0, text: "hi" }] } as never);

    render(<Runner html={html} name="dup" apiBase="" needs={["session-data"]} />);
    const open = await screen.findByRole("button", { name: /replay yours/i });
    fireEvent.click(open);
    // picker lists the viewer's local sessions
    const row = await screen.findByText(/app/);
    fireEvent.click(row);
    await waitFor(() => expect(data).toHaveBeenCalled());
    // host-initiated rebind pins the fetch to the picked session (sessionId/agent forwarded, unlike the AUTO path)
    expect(data.mock.calls[0][1]).toMatchObject({ query: { name: "dup", sessionId: "mine-1", agent: "codex" } });
    vi.unstubAllGlobals();
  });

  it("does not offer the picker without the session-data need", () => {
    render(<Runner html={html} name="g" apiBase="" needs={["invoke-agent"]} />);
    expect(screen.queryByRole("button", { name: /replay yours/i })).toBeNull();
  });

  it("does not offer the picker for a non-interactive thumbnail", () => {
    render(<Runner html={html} name="g" apiBase="" needs={["session-data"]} interactive={false} />);
    expect(screen.queryByRole("button", { name: /replay yours/i })).toBeNull();
  });

  it("a gated-cap consent prompt closes an open picker instead of stacking on top of it", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/watch/sessions")) return { ok: true, json: async () => ({ sessions }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);

    const { container } = render(<Runner html={html} name="dup2" apiBase="" needs={["session-data", "local-project-access"]} />);
    const open = await screen.findByRole("button", { name: /replay yours/i });
    fireEvent.click(open);
    expect(await screen.findByRole("dialog", { name: "Pick a session to replay" })).toBeTruthy(); // picker open

    const win = (container.querySelector("iframe") as HTMLIFrameElement).contentWindow as Window;
    callTool(win, "agentgem_get_inventory"); // gated cap request while the picker is open

    await waitFor(() => expect(screen.getByText("Allow")).toBeTruthy());                          // consent prompt now shown
    expect(screen.queryByRole("dialog", { name: "Pick a session to replay" })).toBeNull();          // picker closed, not stacked
    vi.unstubAllGlobals();
  });

  const stubSessions = () => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (String(url).includes("/api/watch/sessions")) return { ok: true, json: async () => ({ sessions }) };
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch);

  it("closes the picker on Escape and returns focus to the trigger", async () => {
    stubSessions();
    render(<Runner html={html} name="dup" apiBase="" needs={["session-data"]} />);
    const open = await screen.findByRole("button", { name: /replay yours/i });
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Pick a session to replay" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pick a session to replay" })).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("activates a session row via the keyboard (Enter)", async () => {
    stubSessions();
    const data = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [{ role: "user", tsMs: 0, text: "hi" }] } as never);
    render(<Runner html={html} name="dup" apiBase="" needs={["session-data"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /replay yours/i }));
    const row = (await screen.findByText(/app/)).closest('[role="button"]') as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(data).toHaveBeenCalled());
    expect(data.mock.calls[0][1]).toMatchObject({ query: { name: "dup", sessionId: "mine-1", agent: "codex" } });
  });

  it("surfaces an error and keeps the picker open when a session fails to load", async () => {
    stubSessions();
    vi.spyOn(playSessionDataRoute, "call").mockRejectedValue(new Error("404"));
    render(<Runner html={html} name="dup" apiBase="" needs={["session-data"]} />);
    fireEvent.click(await screen.findByRole("button", { name: /replay yours/i }));
    fireEvent.click(await screen.findByText(/app/));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/couldn't load that session/i);
    expect(screen.getByRole("dialog", { name: "Pick a session to replay" })).toBeTruthy(); // stays open on failure
  });
});
