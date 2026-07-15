// packages/console/src/panels/Play/__tests__/mcpHostTools.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { playSessionDataRoute, inventoryRoute } from "../../../api/routes.js";
import * as watchStream from "../../Watch/watchStream.js";
import * as studioStream from "../studioStream.js";
import {
  getSessionData, getInventory, subscribeSessions, openNeutralChat, invokeAgent,
  CAP_TOOL, TOOL_CAP, HOST_TOOLS,
} from "../mcpHostTools.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("getSessionData", () => {
  it("no args → query {name} only, returns the route result", async () => {
    const result = { meta: { project: "p" }, timeline: [{ role: "user", tsMs: 1, text: "hi" }] };
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue(result);
    await expect(getSessionData("", "g1")).resolves.toEqual(result);
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1" } });
  });

  it("with args → passes sessionId + agent (the 'Replay yours' rebind path)", async () => {
    const spy = vi.spyOn(playSessionDataRoute, "call").mockResolvedValue({ meta: {}, timeline: [] });
    await getSessionData("", "g1", { sessionId: "s1", agent: "codex" });
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { name: "g1", sessionId: "s1", agent: "codex" } });
  });
});

describe("getInventory", () => {
  it("returns result and requests deferred bodies (metadata only, not 5.81MB of SKILL.md)", async () => {
    const inv = { skills: [{ name: "brainstorming" }], mcpServers: [], instructions: [], hooks: [], subagents: [] };
    const spy = vi.spyOn(inventoryRoute, "call").mockResolvedValue(inv as never);
    await expect(getInventory("")).resolves.toEqual(inv);
    expect(spy).toHaveBeenCalledWith(expect.anything(), { query: { body: "defer" } });
  });
});

describe("subscribeSessions", () => {
  it("with a session: subscribes to the most-recent one and forwards events", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([
      { id: "s", file: "/f.jsonl", agent: "claude", project: null, model: null, msgs: 1, startMs: 0, endMs: 0, ageMs: 0 },
    ]);
    let emit: (e: unknown) => void = () => {};
    const close = vi.fn();
    const open = vi.spyOn(watchStream, "openWatchStream").mockImplementation((_a, _f, cb) => { emit = cb as (e: unknown) => void; return close; });
    const events: unknown[] = [];
    const result = await subscribeSessions("", (e) => events.push(e));
    expect(result.status).toBe("subscribed");
    expect(open).toHaveBeenCalledWith("", "/f.jsonl", expect.any(Function));
    emit({ type: "event", index: 0 });
    expect(events).toEqual([{ type: "event", index: 0 }]);
    if (result.status === "subscribed") { result.handle.close(); expect(close).toHaveBeenCalled(); }
  });

  it("no sessions: idle, and openWatchStream is NOT called", async () => {
    vi.spyOn(watchStream, "fetchSessions").mockResolvedValue([]);
    const open = vi.spyOn(watchStream, "openWatchStream");
    const result = await subscribeSessions("", () => {});
    expect(result).toEqual({ status: "idle" });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("openNeutralChat", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("picks the available agent and posts /api/chat with NO miniapp field", async () => {
    let chatBody: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/agents")) {
        return { ok: true, json: async () => ({ agents: [{ id: "codex", available: false }, { id: "claude", available: true }] }) };
      }
      chatBody = init?.body as string;
      return { ok: true, json: async () => ({ chatId: "c1" }) };
    }) as unknown as typeof fetch);

    const chatId = await openNeutralChat("");
    expect(chatId).toBe("c1");
    const parsed = JSON.parse(chatBody!);
    expect(parsed).toEqual({ agentId: "claude" });
    expect(parsed.miniapp).toBeUndefined(); // security-critical: this chat is neutral, never gem-scoped
  });

  it("falls back to the first agent when none is marked available", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      String(url).includes("/api/agents") ? { ok: true, json: async () => ({ agents: [{ id: "codex" }] }) }
        : { ok: true, json: async () => ({ chatId: "c2" }) }) as unknown as typeof fetch);

    await expect(openNeutralChat("")).resolves.toBe("c2");
  });
});

describe("invokeAgent", () => {
  it("calls openStudioStream(apiBase, chatId, message, handlers) and wires delta/tool/done/failed through", () => {
    let handlers: studioStream.StudioStreamHandlers | undefined;
    const close = vi.fn();
    const open = vi.spyOn(studioStream, "openStudioStream").mockImplementation((_a, _c, _m, h) => { handlers = h; return close; });
    const onDelta = vi.fn(), onTool = vi.fn(), onDone = vi.fn(), onFailed = vi.fn();

    const handle = invokeAgent("", "c1", "hello agent", { onDelta, onTool, onDone, onFailed });
    expect(open).toHaveBeenCalledWith("", "c1", "hello agent", expect.anything());

    handlers!.onDelta("hi there");
    expect(onDelta).toHaveBeenCalledWith("hi there");
    handlers!.onTool({ title: "search" });
    expect(onTool).toHaveBeenCalledWith({ title: "search" });
    handlers!.onDone({ text: "done", toolCalls: [] });
    expect(onDone).toHaveBeenCalled();
    handlers!.onFailed("boom");
    expect(onFailed).toHaveBeenCalledWith("boom");

    handle.close();
    expect(close).toHaveBeenCalled();
  });
});

describe("CAP_TOOL / TOOL_CAP / HOST_TOOLS", () => {
  it("CAP_TOOL and TOOL_CAP are exact inverses over 5 capabilities", () => {
    expect(Object.keys(CAP_TOOL)).toHaveLength(5);
    expect(Object.keys(TOOL_CAP)).toHaveLength(5);
    for (const [cap, tool] of Object.entries(CAP_TOOL)) expect(TOOL_CAP[tool]).toBe(cap);
  });

  it("HOST_TOOLS has the 5 exact tool names, each visibility:['app']", () => {
    expect(HOST_TOOLS).toHaveLength(5);
    expect(HOST_TOOLS.map((t) => t.name).sort()).toEqual([
      "agentgem_get_inventory",
      "agentgem_get_session_data",
      "agentgem_invoke_agent",
      "agentgem_subscribe_hygiene",
      "agentgem_subscribe_sessions",
    ]);
    for (const t of HOST_TOOLS) expect(t._meta.ui.visibility).toEqual(["app"]);
    expect(HOST_TOOLS.every((t) => t._meta.ui.resourceUri === "")).toBe(true);
  });
});
