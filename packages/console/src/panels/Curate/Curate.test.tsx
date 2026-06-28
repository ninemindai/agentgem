import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Curate } from "./index.js";

afterEach(cleanup);

// @agentback/client parses responses via `response.text()` + JSON.parse and
// reads `ok`/`status` — so the stub only needs those.
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory"))
      return res({ skills: [{ name: "pdf", content: "PDF-SKILL-BODY" }, { name: "csv" }, { name: "zip" }], mcpServers: [], instructions: [], hooks: [] });
    if (u.includes("/api/usage"))
      return res({ artifacts: [
        { type: "skill", name: "pdf", invocations: 7, lastUsedMs: 100 },
        { type: "skill", name: "zip", invocations: 3, lastUsedMs: 900 },
      ] });
    if (u.includes("/api/scaffold-checks"))
      return res({ checks: [{ kind: "behavioral", name: "smoke-test", task: "does it load" }] });
    if (u.includes("/api/workspaces"))
      return res({ name: "my-selection" });
    if (u.includes("/api/archive"))
      return res({ tarGz: btoa("fake-gem-bytes") });
    if (u.includes("/api/gem"))
      return res({ name: "gem", createdFrom: "/x/.claude", artifacts: [{ type: "skill", name: "pdf" }], checks: [], requiredSecrets: [] });
    throw new Error(`unexpected url ${u}`);
  });
}

const usedOnly = () => screen.getByLabelText(/used only/i);

const names = (c: HTMLElement) =>
  Array.from(c.querySelectorAll(".ledger-item-name")).map((n) => n.textContent);

describe("Curate", () => {
  it("shows all items by default, sorted by uses desc (including zero-use)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(names(container)).toEqual(["pdf", "zip", "csv"]);
  });

  it("defaults to the Compose tab and switches to the Suggest tab", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf"); // compose inventory visible by default
    expect((screen.getByRole("tab", { name: "Compose from artifacts" }) as HTMLElement).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Suggest from a project" }));
    expect(await screen.findByText(/agentgem reads its sessions/i)).toBeTruthy(); // analyze intro
    expect(screen.queryByText("pdf")).toBeNull(); // compose inventory hidden
  });

  it("hides zero-use items when 'Used only' is checked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(usedOnly());
    await waitFor(() => expect(names(container)).toEqual(["pdf", "zip"]));
  });

  it("filters by search query", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "zip" } });
    await waitFor(() => expect(names(container)).toEqual(["zip"]));
  });

  it("sorts by last used desc when 'Last used' is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByText("Last used"));
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf", "csv"]));
  });

  it("views an artifact's content inline", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    expect(screen.queryByText("PDF-SKILL-BODY")).toBeNull();
    fireEvent.click(screen.getByText("view"));
    expect(await screen.findByText("PDF-SKILL-BODY")).toBeTruthy();
  });

  it("suggests checks for the selection", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByLabelText("pdf"));
    fireEvent.click(screen.getByText("Suggest checks"));
    expect(await screen.findByText("smoke-test")).toBeTruthy();
    expect(screen.getByText("behavioral")).toBeTruthy();
  });

  it("saves the current selection as a workspace", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByLabelText("pdf"));
    fireEvent.change(screen.getByLabelText("workspace name"), { target: { value: "my-selection" } });
    fireEvent.click(screen.getByText("Save workspace"));
    await waitFor(() => expect(screen.getByText(/saved workspace .my-selection./)).toBeTruthy());
  });

  it("clears the selection", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByLabelText("pdf"));
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.getByText("0 selected")).toBeTruthy();
  });

  it("points at the 'Used only' toggle when usage is empty but artifacts exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory"))
        return res({ skills: [{ name: "pdf" }], mcpServers: [], instructions: [], hooks: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(usedOnly()); // turn the focus filter ON; pdf has no usage → category empties
    expect(await screen.findByText(/uncheck .Used only. to browse all 1/i)).toBeTruthy();
  });

});
