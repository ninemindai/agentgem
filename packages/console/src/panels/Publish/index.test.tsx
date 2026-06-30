import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { RegistryPublish } from "./index";

afterEach(cleanup);
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const ws = [{ name: "my-gem", gemName: "my-gem", version: "1.0.0", artifactCounts: { skill: 1, mcp_server: 0, instructions: 0, hook: 0 }, artifacts: [], modifiedMs: 0, checks: 0, renderedTargets: [] }];

describe("RegistryPublish", () => {
  it("shows a 'not configured' message when the registry is not ready", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/api/registry/ready")) return res({ ready: false });
      if (String(url).includes("/api/workspaces")) return res({ workspaces: [] });
      throw new Error(`unexpected ${url}`);
    }));
    render(<RegistryPublish apiBase="" />);
    expect(await screen.findByText(/not configured/i)).toBeTruthy();
  });

  it("publishes a selected workspace and shows the published ref", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); calls.push(u);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/workspaces")) return res({ workspaces: ws });
      if (u.includes("/api/registry/publish")) return res({ ref: "@me/my-gem", version: "1.0.0", gemDigest: "sha256:d", commit: "abc", path: "items/me/my-gem/1.0.0" });
      throw new Error(`unexpected ${u}`);
    }));
    render(<RegistryPublish apiBase="" />);
    await screen.findByRole("option", { name: "my-gem" });          // workspaces loaded
    fireEvent.change(screen.getByLabelText(/workspace/i), { target: { value: "my-gem" } });
    fireEvent.change(screen.getByLabelText(/scope/i), { target: { value: "me" } });
    fireEvent.click(screen.getByRole("button", { name: /publish/i }));
    await waitFor(() => expect(calls.some((u) => u.includes("/api/registry/publish"))).toBe(true));
    expect(await screen.findByText(/@me\/my-gem/)).toBeTruthy();
  });
});
