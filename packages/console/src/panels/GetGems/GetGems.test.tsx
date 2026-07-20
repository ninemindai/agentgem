import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GetGems } from "./index.js";

afterEach(() => { cleanup(); window.location.hash = ""; });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const errRes = (status: number, body: unknown) =>
  ({ ok: false, status, text: async () => JSON.stringify(body) }) as unknown as Response;

describe("GetGems", () => {
  it("renders the marketplace pointer and the .gem import card", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no request expected"); }));
    render(<GetGems apiBase="" />);
    expect(await screen.findByText(/browse the marketplace/i)).toBeTruthy();
    expect(screen.getByText("Import a .gem file")).toBeTruthy();
  });

  it("directly installs from an ?install= deep link", async () => {
    window.location.hash = "#/get-gems?install=%40o%2Fsetup&v=1.0.0"; // "Open in AgentGem" on an installable gem
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/install-hosted")) return res({ workspace: "o-setup", executables: { mcp: [], hooks: [] } });
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    await waitFor(() => expect(screen.getByText(/installed → o-setup/i)).toBeTruthy());
  });

  it("gates a deep-link install on consent for executable artifacts, then installs on confirm", async () => {
    window.location.hash = "#/get-gems?install=%40acme%2Fsetup&v=1.0.0";
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/install-hosted")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (!body.consent) return errRes(409, { error: { message: "this setup runs executable artifacts; install requires consent", code: "consent_required" } });
        return res({ workspace: "acme-setup", executables: { mcp: ["gh"], hooks: [] } });
      }
      throw new Error(`unexpected ${u}`);
    }));
    render(<GetGems apiBase="" />);
    fireEvent.click(await screen.findByText(/install anyway/i)); // consent gate → confirm
    await waitFor(() => expect(screen.getByText(/installed → acme-setup/i)).toBeTruthy());
  });
});
