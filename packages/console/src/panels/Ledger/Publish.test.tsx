import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Publish } from "./Publish.js";

afterEach(cleanup);
beforeEach(() => {
  // jsdom lacks crypto.randomUUID in some setups
  if (!globalThis.crypto?.randomUUID) {
    vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000000" });
  }
});

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("Publish", () => {
  it("gates on publish-ready and publishes, then undeploys", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/publish-ready")) return res({ ready: true });
      if (u.includes("/api/undeploy")) return res({ removed: true });
      if (u.includes("/api/publish")) return res({ kind: "managed-agent", agentId: "ag_123", environmentId: "env_1", version: "1" });
      throw new Error(`unexpected ${u}`);
    }));
    render(<Publish apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);

    await waitFor(() => expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(await screen.findByText(/published \(managed-agent\) — agent ag_123/)).toBeTruthy();

    fireEvent.click(screen.getByText("Undeploy"));
    await waitFor(() => expect(screen.getByText(/undeployed/)).toBeTruthy());
  });

  it("disables publish when the backend is not ready", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/publish-ready")) return res({ ready: false });
      throw new Error("unexpected");
    }));
    render(<Publish apiBase="" selection={{ skills: ["pdf"] }} name="gem" />);
    await waitFor(() => expect(screen.getByText(/not configured/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
