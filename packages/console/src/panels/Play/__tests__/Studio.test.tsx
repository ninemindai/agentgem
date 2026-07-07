// packages/console/src/panels/Play/__tests__/Studio.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { playMiniappRoute } from "../../../api/routes.js";

class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Studio", () => {
  it("opens a studio chat targeting the miniapp and refreshes the preview on done", async () => {
    // raw-fetch endpoints (agents + POST /api/chat); the client-route preview is spied separately
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/chat") && init?.method === "POST") { post(init); return { ok: true, json: async () => ({ chatId: "c1" }) }; }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const spy = vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "g1", html: "<!doctype html><body><canvas data-v=\"2\"></canvas></body>",
      meta: { title: "G1", genre: "replay", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    });

    render(<Studio
      apiBase=""
      name="g1"
      agents={[{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }]}
      agentId="codex"
      onAgentIdChange={() => {}}
      onBack={() => {}}
    />);

    // mount refresh renders the fetched html into the sealed preview
    await waitFor(() => {
      const iframe = document.querySelector('iframe[title="miniapp preview"]') as HTMLIFrameElement;
      expect(iframe?.getAttribute("srcdoc")).toContain('data-v="2"');
    });

    fireEvent.change(screen.getByPlaceholderText(/build\/edit/i), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(FakeES.last!.url).toContain("/api/chat/stream");
    expect(JSON.parse(String(post.mock.calls[0][0].body))).toMatchObject({ agentId: "codex", miniapp: "g1" });

    const before = spy.mock.calls.length;
    FakeES.last!.emit("done", { result: { text: "done", toolCalls: [] } });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before)); // refreshed on done
  });

  // A blank miniapp created with a description auto-kicks the build: the description is sent as the
  // studio's first chat message, with no typing.
  const blankApp = {
    name: "space-dodger", html: "<!doctype html><body></body>",
    meta: { title: "Space Dodger", genre: "project-fun", createdFrom: { kind: "blank", title: "Space Dodger" }, engineVersion: "1" },
  } as const;
  const stubChat = (post = vi.fn()) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/chat") && init?.method === "POST") { post(init); return { ok: true, json: async () => ({ chatId: "c1" }) }; }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    return post;
  };
  const codex = [{ id: "codex", name: "Codex", available: true }];

  it("auto-sends the seed prompt as the studio's first build message (no typing)", async () => {
    const post = stubChat();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);

    render(<Studio apiBase="" name="space-dodger" seedPrompt="dodge asteroids" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} />);

    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(JSON.parse(String(post.mock.calls[0][0].body))).toMatchObject({ agentId: "codex", miniapp: "space-dodger" });
    expect(FakeES.last!.url).toContain("message=dodge+asteroids");
    expect(screen.getByText("dodge asteroids")).toBeTruthy(); // shown as the first user bubble
  });

  it("does not auto-send when there is no seed prompt", async () => {
    stubChat();
    const spy = vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);
    render(<Studio apiBase="" name="space-dodger" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(FakeES.last).toBeNull();
  });

  it("waits for an agent, then fires the seed prompt exactly once", async () => {
    stubChat();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);
    const props = { apiBase: "", name: "space-dodger", seedPrompt: "dodge asteroids", onAgentIdChange: () => {}, onBack: () => {} };
    const { rerender } = render(<Studio {...props} agents={null} agentId="" />);
    await waitFor(() => expect(playMiniappRoute.call).toHaveBeenCalled());
    expect(FakeES.last).toBeNull(); // no agent yet → held

    rerender(<Studio {...props} agents={codex} agentId="codex" />);
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(FakeES.last!.url).toContain("message=dodge+asteroids");
  });
});
