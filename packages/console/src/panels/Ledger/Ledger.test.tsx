import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
      return res({ skills: [{ name: "pdf" }, { name: "csv" }, { name: "zip" }], mcpServers: [], instructions: [], hooks: [] });
    if (u.includes("/api/usage"))
      return res({ artifacts: [
        { type: "skill", name: "pdf", invocations: 7, lastUsedMs: 100 },
        { type: "skill", name: "zip", invocations: 3, lastUsedMs: 900 },
      ] });
    throw new Error(`unexpected url ${u}`);
  });
}

const names = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".ledger-item-name")).map((n) => n.textContent);

describe("Ledger", () => {
  it("shows used items by default, sorted by uses desc (zero-use hidden)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Ledger apiBase="" />);
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(names(container)).toEqual(["pdf", "zip"]);
  });

  it("reveals zero-use items when 'Used only' is unchecked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Ledger apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(names(container)).toEqual(["pdf", "zip", "csv"]));
  });

  it("filters by search query", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Ledger apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "zip" } });
    await waitFor(() => expect(names(container)).toEqual(["zip"]));
  });

  it("sorts by last used desc when 'Last used' is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Ledger apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByText("Last used"));
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf"]));
  });

  it("points at the 'Used only' toggle when usage is empty but artifacts exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory"))
        return res({ skills: [{ name: "pdf" }], mcpServers: [], instructions: [], hooks: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));
    render(<Ledger apiBase="" />);
    expect(await screen.findByText(/uncheck .Used only. to browse all 1/i)).toBeTruthy();
  });
});
