import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Deploy } from "./index.js";
import { setKeys, resetGem } from "../../activeGem.js";

afterEach(() => { cleanup(); resetGem(); });
const res = (b: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as unknown as Response;

describe("Deploy", () => {
  it("nudges to Curate when nothing is selected", () => {
    render(<Deploy apiBase="" />);
    expect(screen.getByText(/curate some artifacts first/i)).toBeTruthy();
  });

  it("renders Publish + workspace-deploy when a Gem is active", async () => {
    setKeys(new Set(["skills::pdf"]));
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/publish-ready")) return res({ ready: false });
      if (u.includes("/api/run-ready")) return res({ local: true, vercel: false, cloudflare: false });
      return res({});
    }));
    render(<Deploy apiBase="" />);
    expect(await screen.findAllByText(/Publish/i)).toBeTruthy();
    // WorkspaceDeploy also renders — its run-ready "local" mode surfaces "Run locally".
    expect(await screen.findByText(/Run locally/i)).toBeTruthy();
  });
});
