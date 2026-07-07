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
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/agents")) return { ok: true, json: async () => ({ agents: [{ id: "claude", available: true }] }) };
      if (String(url).includes("/api/chat") && init?.method === "POST") return { ok: true, json: async () => ({ chatId: "c1" }) };
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch);
    vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
    const spy = vi.spyOn(playMiniappRoute, "call").mockResolvedValue({
      name: "g1", html: "<!doctype html><body><canvas data-v=\"2\"></canvas></body>",
      meta: { title: "G1", genre: "replay", createdFrom: { kind: "project", path: "/p", flavor: "node" }, engineVersion: "1" },
    });

    render(<Studio apiBase="" name="g1" onBack={() => {}} />);

    // mount refresh renders the fetched html into the sealed preview
    await waitFor(() => {
      const iframe = document.querySelector('iframe[title="miniapp preview"]') as HTMLIFrameElement;
      expect(iframe?.getAttribute("srcdoc")).toContain('data-v="2"');
    });

    fireEvent.change(screen.getByPlaceholderText(/build\/edit/i), { target: { value: "make it blue" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(FakeES.last!.url).toContain("/api/chat/stream");

    const before = spy.mock.calls.length;
    FakeES.last!.emit("done", { result: { text: "done", toolCalls: [] } });
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThan(before)); // refreshed on done
  });
});
