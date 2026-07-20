// packages/console/src/panels/Play/__tests__/Studio.uploads.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Studio } from "../Studio.js";
import { playMiniappRoute, playUploadsRoute } from "../../../api/routes.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";

// Same fake EventSource the rest of Studio's tests use — send() opens a stream with the message
// baked into the URL's `message` query param, which is the seam these tests read the sent text
// from (Studio has no test-only send seam).
class FakeES {
  static last: FakeES | null = null;
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  constructor(public url: string) { FakeES.last = this; }
  addEventListener(t: string, cb: (e: unknown) => void) { (this.listeners[t] ??= []).push(cb); }
  close() {}
  emit(t: string, data: unknown) { for (const cb of this.listeners[t] ?? []) cb({ data: JSON.stringify(data) }); }
}
afterEach(() => { cleanup(); FakeES.last = null; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function file(name: string, type: string, body = "x") { return new File([body], name, { type }); }

const blankApp = {
  name: "g", html: "<!doctype html><body></body>",
  meta: { title: "G", genre: "project-fun", createdFrom: { kind: "blank", title: "G" }, engineVersion: "1" },
} as const;
const codex = [{ id: "codex", name: "Codex", available: true }];

const stubChat = () => {
  const post = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/chat") && init?.method === "POST") { post(init); return { ok: true, json: async () => ({ chatId: "c1" }) }; }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch);
  vi.stubGlobal("EventSource", FakeES as unknown as typeof EventSource);
  return post;
};

describe("Studio mid-session uploads", () => {
  it("attaching a file + Send posts /play/uploads then sends a preamble with the SERVER stored name", async () => {
    stubChat();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);
    const uploadSpy = vi.spyOn(playUploadsRoute, "call").mockResolvedValue({
      files: [{ requested: "My Logo.png", stored: "my-logo.png", role: "ship" }], ship: 1, ref: 0,
    } as never);

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="g" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const input = await screen.findByTestId("uploads-input");
    fireEvent.change(input, { target: { files: [file("My Logo.png", "image/png")] } });
    await screen.findByTestId("role-My Logo.png");

    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalled());
    expect(uploadSpy.mock.calls[0][1].body).toMatchObject({ name: "g", files: [{ name: "My Logo.png", role: "ship" }] });

    // the agent hears the SERVER's stored filename, not the raw staged name
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(FakeES.last!.url).toContain("my-logo.png");
    expect(FakeES.last!.url).not.toContain("Logo.png"); // "My Logo.png" would encode with a capital L

    // chips clear on upload success
    expect(screen.queryByTestId("role-My Logo.png")).toBeNull();
  });

  it("keeps the chips and never sends when the upload POST fails", async () => {
    stubChat();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);
    const uploadSpy = vi.spyOn(playUploadsRoute, "call").mockRejectedValue(new Error("boom"));

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="g" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const input = await screen.findByTestId("uploads-input");
    fireEvent.change(input, { target: { files: [file("logo.png", "image/png")] } });
    await screen.findByTestId("role-logo.png");

    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => expect(uploadSpy).toHaveBeenCalled());
    expect(await screen.findByText(/upload failed/i)).toBeTruthy();
    expect(screen.getByTestId("role-logo.png")).toBeTruthy(); // chip survives a failed upload
    expect(FakeES.last).toBeNull(); // never reached send()
  });

  // The upload POST is awaited before send() sets `busy`, so without submit() claiming `busy`
  // itself up front, the Send button stays enabled for the whole round trip — a second click
  // while the first upload is still in flight would fire a duplicate POST of the same staged
  // files (the server suffixes the collision and the agent hears about both copies).
  it("does not fire a second upload POST from a click while the first is still in flight", async () => {
    stubChat();
    vi.spyOn(playMiniappRoute, "call").mockResolvedValue(blankApp as never);
    let resolveUpload!: (v: { files: { requested: string; stored: string; role: "ship" }[]; ship: number; ref: number }) => void;
    const uploadSpy = vi.spyOn(playUploadsRoute, "call").mockImplementation(
      () => new Promise((resolve) => { resolveUpload = resolve; }) as never,
    );

    render(<IdentityProvider apiBase=""><Studio apiBase="" name="g" agents={codex} agentId="codex" onAgentIdChange={() => {}} onBack={() => {}} /></IdentityProvider>);

    const input = await screen.findByTestId("uploads-input");
    fireEvent.change(input, { target: { files: [file("logo.png", "image/png")] } });
    await screen.findByTestId("role-logo.png");

    // Query the button once and reuse the handle: mid-flight it shows busy text ("…"), not "Send".
    const sendBtn = screen.getByText("Send");
    fireEvent.click(sendBtn);
    await waitFor(() => expect(uploadSpy).toHaveBeenCalledTimes(1));
    fireEvent.click(sendBtn); // second click while the first POST is still pending
    await new Promise((r) => setTimeout(r, 0));
    expect(uploadSpy).toHaveBeenCalledTimes(1); // still just the one call

    resolveUpload({ files: [{ requested: "logo.png", stored: "logo.png", role: "ship" }], ship: 1, ref: 0 });
    await waitFor(() => expect(FakeES.last).toBeTruthy());
    expect(uploadSpy).toHaveBeenCalledTimes(1); // resolving didn't retroactively let a queued second call through
  });
});
