import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Ledger } from "./index.js";

afterEach(cleanup);

// @agentback/client parses responses via `response.text()` + JSON.parse and
// reads `ok`/`status` — so the stub only needs those.
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory"))
      return res({ skills: [{ name: "pdf" }], mcpServers: [], instructions: [], hooks: [] });
    if (u.includes("/api/usage"))
      return res({ artifacts: [{ type: "skill", name: "pdf", invocations: 7 }] });
    throw new Error(`unexpected url ${u}`);
  });
}

describe("Ledger", () => {
  it("renders the inventory grouped, with usage badges", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Ledger apiBase="" />);
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
  });
});
