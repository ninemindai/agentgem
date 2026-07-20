import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Settings } from "./index.js";
import * as routes from "../../api/routes.js";
import { IdentityProvider } from "../../identity/IdentityProvider.js";

const renderSettings = () => render(<IdentityProvider apiBase=""><Settings apiBase="" /></IdentityProvider>);

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch(overrides: Record<string, unknown> = {}) {
  // Stateful: a completed bind must be reflected by the NEXT /api/bind/status call,
  // the same way the real aggregator behaves — otherwise this stub can't tell the
  // difference between a correct refresh()-driven update and a clobbered one.
  let bound = false;
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/bind/status"))
      return res(overrides["/api/bind/status"] ?? (bound ? { bound: true, login: "alice", sessionActive: true } : { bound: false }));
    if (u.includes("/api/bind/start"))
      return res(overrides["/api/bind/start"] ?? {
        configured: true,
        userCode: "WXYZ-1234",
        verificationUri: "https://github.com/login/device",
        deviceCode: "dc",
        interval: 5,
      });
    if (u.includes("/api/bind/complete")) {
      const body = overrides["/api/bind/complete"] ?? { bound: true, login: "alice" };
      if ((body as { bound?: boolean }).bound) bound = true;
      return res(body);
    }
    throw new Error(`unexpected ${u}`);
  });
}

describe("Settings", () => {
  it("shows Not verified when unbound", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderSettings();
    expect(await screen.findByText(/Not verified/)).toBeTruthy();
  });

  it("shows code, then verifies after the copy-&-open click starts the poll", async () => {
    vi.stubGlobal("open", vi.fn());
    let resolveComplete!: (v: unknown) => void;
    const completePending = new Promise<unknown>((resolve) => { resolveComplete = resolve; });
    let completeCalls = 0;
    let bound = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status")) return res(bound ? { bound: true, login: "alice", sessionActive: true } : { bound: false });
      if (u.includes("/api/bind/start"))
        return res({ configured: true, userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 });
      if (u.includes("/api/bind/complete")) { completeCalls++; return completePending.then(() => { bound = true; return res({ bound: true, login: "alice" }); }); }
      throw new Error(`unexpected ${u}`);
    }));
    renderSettings();
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    // Code shows; poll has NOT started yet (no /complete call until copy-&-open).
    expect(await screen.findByText("WXYZ-1234")).toBeTruthy();
    expect(completeCalls).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    resolveComplete(undefined);
    expect(await screen.findByText(/Verified as @alice/)).toBeTruthy();
    expect(completeCalls).toBe(1);
  });

  it("does not clobber the refreshed identity after a bind lands — the web handoff button and avatar survive", async () => {
    vi.stubGlobal("open", vi.fn());
    let bound = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/bind/status"))
        return res(bound
          ? { bound: true, login: "alice", avatarUrl: "https://a/alice.png", sessionActive: true }
          : { bound: false });
      if (u.includes("/api/bind/start"))
        return res({ configured: true, userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 });
      if (u.includes("/api/bind/complete")) { bound = true; return res({ bound: true, login: "alice" }); }
      throw new Error(`unexpected ${u}`);
    }));
    renderSettings();
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    await screen.findByText("WXYZ-1234");
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(await screen.findByRole("button", { name: /Open on the web ↗/ })).toBeTruthy();
    const img = await screen.findByRole("img", { name: /alice/i });
    expect(img.getAttribute("src")).toBe("https://a/alice.png");
  });

  it("shows Verification unavailable when not configured", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/bind/start": { configured: false } }));
    renderSettings();
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText(/Verification unavailable/)).toBeTruthy();
  });

  it("renders the GitHub avatar when the binding has one", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png" } as any);
    renderSettings();
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
    expect(screen.getByText(/Verified as @bob/)).toBeTruthy();
  });

  it("shows a friendly guidance message for the unknown-producer rejection (not the raw slug)", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as any);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 } as any);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: false, rejected: "unknown-producer" } as any);
    vi.stubGlobal("open", vi.fn());
    renderSettings();
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText("AB-12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(await screen.findByText(/Publish or share a Gem first/)).toBeTruthy();
    expect(screen.queryByText(/^unknown-producer$/)).toBeNull();
  });

  it("disconnects a bound identity and returns to the Connect state", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as any);
    const disconnect = vi.spyOn(routes.bindDisconnectRoute, "call").mockResolvedValue({ bound: false } as any);
    renderSettings();
    await screen.findByText(/Verified as @bob/);
    fireEvent.click(screen.getByText("Disconnect"));
    expect(await screen.findByText("Connect GitHub")).toBeTruthy();
    expect(screen.queryByText(/Verified as @bob/)).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("falls back to text-only when the binding has no avatar", async () => {
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as any);
    renderSettings();
    await screen.findByText(/Verified as @bob/);
    expect(screen.queryByRole("img", { name: /bob/i })).toBeNull();
  });
});
