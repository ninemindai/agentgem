import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceDeploy } from "./WorkspaceDeploy.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("WorkspaceDeploy", () => {
  it("gates modes by run-ready and runs locally", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/run-ready")) return res({ local: true, vercel: false, cloudflare: false });
      if (u.includes("/api/run") && !u.includes("ready"))
        return res({ mode: "local", state: "running", url: "http://localhost:3000", logTail: ["started"] });
      throw new Error(`unexpected ${u}`);
    }));
    render(<WorkspaceDeploy apiBase="" name="demo" />);

    // ready loads → local enabled, vercel disabled
    await waitFor(() => expect((screen.getByText("Run locally") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByText("Deploy to Vercel") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText("Run locally"));
    expect(await screen.findByText("running")).toBeTruthy();
    expect(screen.getByText("http://localhost:3000")).toBeTruthy();
  });
});
