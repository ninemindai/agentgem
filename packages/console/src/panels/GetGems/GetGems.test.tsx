import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GetGems } from "./index.js";
import { setPendingQuery, takePendingQuery } from "./intent.js";

afterEach(() => { cleanup(); takePendingQuery(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("GetGems", () => {
  it("shows a not-configured message when the registry is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/registry/ready")) return res({ ready: false });
      throw new Error("unexpected");
    }));
    render(<GetGems apiBase="" />);
    expect(await screen.findByText(/registry not configured/i)).toBeTruthy();
  });

  it("searches the registry and installs a result to a workspace", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search"))
        return res({ results: [{ key: "acme/starter", latest: "1.0.0", score: 1, description: "a starter", tags: ["cli"] }] });
      if (u.includes("/api/registry/install"))
        return res({ applied: { mode: "workspace", workspace: "acme-starter" } });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    fireEvent.click(await screen.findByText("Search"));
    expect(await screen.findByText("acme/starter")).toBeTruthy();
    expect(screen.getByText("a starter")).toBeTruthy();
    fireEvent.click(screen.getByText("Install to workspace"));
    await waitFor(() => expect(screen.getByText(/installed → acme-starter/i)).toBeTruthy());
  });
});

it("auto-runs a search from a pending cross-panel query", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/registry/ready")) return res({ ready: true });
    if (u.includes("/api/registry/search")) {
      calls.push(u);
      return res({ results: [{ key: "acme/brainstorming-kit", latest: "1.0.0", score: 1, description: "kit", tags: [] }] });
    }
    throw new Error(`unexpected ${u}`);
  }));
  setPendingQuery("brainstorming");
  render(<GetGems apiBase="" />);
  expect(await screen.findByText("acme/brainstorming-kit")).toBeTruthy();
  expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("brainstorming");
  expect(calls.some((u) => u.includes("brainstorming"))).toBe(true);
});

it("does not auto-search on a normal visit (no pending query)", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/registry/ready")) return res({ ready: true });
    if (u.includes("/api/registry/search")) throw new Error("should not search");
    throw new Error(`unexpected ${u}`);
  }));
  render(<GetGems apiBase="" />);
  expect(await screen.findByText("Search")).toBeTruthy();
  expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("");
});
