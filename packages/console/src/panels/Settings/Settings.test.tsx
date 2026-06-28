import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Settings } from "./index.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/deploy-targets"))
      return res({ targets: [
        { id: "claude-managed", label: "Claude Managed Agents", ready: true },
        { id: "agentcore-managed", label: "AgentCore Harness", ready: false },
      ] });
    if (u.includes("/api/credential")) return res({ ok: true });
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
});
