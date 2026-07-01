import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Settings } from "./index.js";

afterEach(cleanup);

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

  it("shows code then Verified after connect flow", async () => {
    let resolveComplete!: (v: unknown) => void;
    const completePending = new Promise<unknown>((resolve) => { resolveComplete = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/deploy-targets")) return res({ targets: [] });
      if (u.includes("/api/bind/status")) return res({ bound: false });
      if (u.includes("/api/bind/start"))
        return res({ configured: true, userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", deviceCode: "dc", interval: 5 });
      if (u.includes("/api/bind/complete"))
        return completePending.then(() => res({ bound: true, login: "alice" }));
      throw new Error(`unexpected ${u}`);
    }));
    render(<Settings apiBase="" />);
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText("WXYZ-1234")).toBeTruthy();
    resolveComplete(undefined);
    expect(await screen.findByText(/Verified as @alice/)).toBeTruthy();
  });

  it("shows Verification unavailable when not configured", async () => {
    vi.stubGlobal("fetch", mockFetch({ "/api/bind/start": { configured: false } }));
    render(<Settings apiBase="" />);
    await screen.findByText(/Not verified/);
    fireEvent.click(screen.getByText("Connect GitHub"));
    expect(await screen.findByText(/Verification unavailable/)).toBeTruthy();
  });
});
