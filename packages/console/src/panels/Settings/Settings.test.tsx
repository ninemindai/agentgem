import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Settings } from "./index.js";
import * as routes from "../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/deploy-targets"))
      return res({ targets: [
        { id: "claude-managed", label: "Claude Managed Agents", ready: true },
        { id: "agentcore-managed", label: "AgentCore Harness", ready: false },
      ] });
    if (u.includes("/api/credential")) return res({ ok: true });
    if (u.includes("/api/bind/status"))
      return res(overrides["/api/bind/status"] ?? { bound: false });
    if (u.includes("/api/bind/start"))
      return res(overrides["/api/bind/start"] ?? {
        configured: true,
        userCode: "WXYZ-1234",
        verificationUri: "https://github.com/login/device",
        deviceCode: "dc",
        interval: 5,
      });
    if (u.includes("/api/bind/complete"))
      return res(overrides["/api/bind/complete"] ?? { bound: true, login: "alice" });
    throw new Error(`unexpected ${u}`);
  });
}

describe("Settings", () => {
  it("lists deploy backends with readiness", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Settings apiBase="" />);
    expect(await screen.findByText("Claude Managed Agents")).toBeTruthy();
    expect(screen.getByText("ready")).toBeTruthy();
    expect(screen.getByText("needs credentials")).toBeTruthy();
  });

  it("saves a credential", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Settings apiBase="" />);
    await screen.findByText("Claude Managed Agents");
    fireEvent.change(screen.getByLabelText("credential value"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/saved ANTHROPIC_API_KEY/)).toBeTruthy());
  });

  it("shows Not verified when unbound", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Settings apiBase="" />);
    expect(await screen.findByText(/Not verified/)).toBeTruthy();
  });

  it("shows code, then verifies after the copy-&-open click starts the poll", async () => {
    vi.stubGlobal("open", vi.fn());
    let resolveComplete!: (v: unknown) => void;
    const completePending = new Promise<unknown>((resolve) => { resolveComplete = resolve; });
    let completeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/deploy-targets")) return res({ targets: [] });
      if (u.includes("/api/bind/status")) return res({ bound: false });
      if (u.includes("/api/bind/start"))
        return res({ configured: true, userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 });
      if (u.includes("/api/bind/complete")) { completeCalls++; return completePending.then(() => res({ bound: true, login: "alice" })); }
      throw new Error(`unexpected ${u}`);
    }));
    render(<Settings apiBase="" />);
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

  it("shows Verification unavailable when not configured", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/bind/start": { configured: false } }));
    render(<Settings apiBase="" />);
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText(/Verification unavailable/)).toBeTruthy();
  });

  it("renders the GitHub avatar when the binding has one", async () => {
    vi.spyOn(routes.deployTargetsRoute, "call").mockResolvedValue({ targets: [] });
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", avatarUrl: "https://a/bob.png" } as any);
    render(<Settings apiBase="" />);
    const img = await screen.findByRole("img", { name: /bob/i });
    expect(img.getAttribute("src")).toBe("https://a/bob.png");
    expect(screen.getByText(/Verified as @bob/)).toBeTruthy();
  });

  it("shows a friendly guidance message for the unknown-producer rejection (not the raw slug)", async () => {
    vi.spyOn(routes.deployTargetsRoute, "call").mockResolvedValue({ targets: [] });
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: false } as any);
    vi.spyOn(routes.bindStartRoute, "call").mockResolvedValue({ configured: true, userCode: "AB-12", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 } as any);
    vi.spyOn(routes.bindCompleteRoute, "call").mockResolvedValue({ bound: false, rejected: "unknown-producer" } as any);
    vi.stubGlobal("open", vi.fn());
    render(<Settings apiBase="" />);
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText("AB-12")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy code & open github/i }));
    expect(await screen.findByText(/Publish or share a Gem first/)).toBeTruthy();
    expect(screen.queryByText(/^unknown-producer$/)).toBeNull();
  });

  it("disconnects a bound identity and returns to the Connect state", async () => {
    vi.spyOn(routes.deployTargetsRoute, "call").mockResolvedValue({ targets: [] });
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as any);
    const disconnect = vi.spyOn(routes.bindDisconnectRoute, "call").mockResolvedValue({ bound: false } as any);
    render(<Settings apiBase="" />);
    await screen.findByText(/Verified as @bob/);
    fireEvent.click(screen.getByText("Disconnect"));
    expect(await screen.findByText("Connect GitHub")).toBeTruthy();
    expect(screen.queryByText(/Verified as @bob/)).toBeNull();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("falls back to text-only when the binding has no avatar", async () => {
    vi.spyOn(routes.deployTargetsRoute, "call").mockResolvedValue({ targets: [] });
    vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob" } as any);
    render(<Settings apiBase="" />);
    await screen.findByText(/Verified as @bob/);
    expect(screen.queryByRole("img", { name: /bob/i })).toBeNull();
  });
});
