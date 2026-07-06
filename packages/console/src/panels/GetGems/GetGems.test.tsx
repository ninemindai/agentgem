import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GetGems } from "./index.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const errRes = (status: number, body: unknown) =>
  ({ ok: false, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("GetGems", () => {
  it("shows a not-configured message when the registry is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      if (String(url).includes("/api/registry/ready")) return res({ ready: false });
      throw new Error("unexpected");
    }));
    render(<GetGems apiBase="" />);
    expect(await screen.findByText(/registry not configured/i)).toBeTruthy();
  });

  it("searches and installs a result via the hosted zero-config path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search"))
        return res({ results: [{ key: "acme/starter", latest: "1.0.0", score: 1, description: "a starter", tags: ["cli"] }] });
      if (u.includes("/api/install-hosted"))
        return res({ workspace: "acme-starter", executables: { mcp: [], hooks: [] } });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    fireEvent.click(await screen.findByText("Search"));
    expect(await screen.findByText("acme/starter")).toBeTruthy();
    fireEvent.click(screen.getByText("Install to workspace"));
    await waitFor(() => expect(screen.getByText(/installed → acme-starter/i)).toBeTruthy());
  });

  it("gates install on consent for executable artifacts, then installs on confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search")) return res({ results: [{ key: "acme/setup", latest: "1.0.0", score: 1 }] });
      if (u.includes("/api/install-hosted")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (!body.consent) return errRes(409, { error: { message: "this setup runs executable artifacts; install requires consent", code: "consent_required" } });
        return res({ workspace: "acme-setup", executables: { mcp: ["gh"], hooks: [] } });
      }
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    fireEvent.click(await screen.findByText("Search"));
    fireEvent.click(await screen.findByText("Install to workspace"));
    fireEvent.click(await screen.findByText(/install anyway/i)); // consent gate → confirm
    await waitFor(() => expect(screen.getByText(/installed → acme-setup/i)).toBeTruthy());
  });

  it("links @publishedBy to the web profile; falls back to the author chip", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search"))
        return res({ results: [
          { key: "acme/pub", latest: "1.0.0", score: 1, publishedBy: "octocat", author: "acme" },
          { key: "acme/noPub", latest: "1.0.0", score: 1, author: "acme" },
        ] });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    fireEvent.click(await screen.findByText("Search"));
    const link = (await screen.findByText("@octocat")).closest("a");
    expect(link?.getAttribute("href")).toBe("https://app.agentgem.ai/@octocat");
    expect(link?.getAttribute("target")).toBe("_blank");
    // the no-publishedBy result shows the free-text author chip, unlinked
    const chip = screen.getByText("acme");
    expect(chip.closest("a")).toBeNull();
  });

  it("auto-searches and prefills the box from a ?q= deep-link param", async () => {
    window.location.hash = "#/get-gems?q=%40raymondfeng%2Fmy-setup"; // "Open in AgentGem" link
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search"))
        return res({ results: [{ key: "@raymondfeng/my-setup", latest: "1.0.0", score: 1, description: "my setup" }] });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    expect(await screen.findByText("@raymondfeng/my-setup")).toBeTruthy();
    expect((screen.getByLabelText("search registry") as HTMLInputElement).value).toBe("@raymondfeng/my-setup");
  });

  it("directly installs from an ?install= deep link (no search)", async () => {
    window.location.hash = "#/get-gems?install=%40o%2Fsetup&v=1.0.0"; // "Open in AgentGem" on an installable gem
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: true });
      if (u.includes("/api/registry/search")) throw new Error("should not search on ?install");
      if (u.includes("/api/install-hosted")) return res({ workspace: "o-setup", executables: { mcp: [], hooks: [] } });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    await waitFor(() => expect(screen.getByText(/installed → o-setup/i)).toBeTruthy());
  });

  it("direct install works even when registry search is not configured", async () => {
    window.location.hash = "#/get-gems?install=%40o%2Fsetup&v=1.0.0";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/registry/ready")) return res({ ready: false }); // not configured
      if (u.includes("/api/install-hosted")) return res({ workspace: "o-setup", executables: { mcp: [], hooks: [] } });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    await waitFor(() => expect(screen.getByText(/installed → o-setup/i)).toBeTruthy());
  });

  it("does not auto-search on mount", async () => {
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
});
