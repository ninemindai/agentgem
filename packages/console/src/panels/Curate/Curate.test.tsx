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
  it("shows used items by default, sorted by uses desc (zero-use hidden)", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(names(container)).toEqual(["pdf", "zip"]);
  });

  it("reveals zero-use items when 'Used only' is unchecked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(usedOnly());
    await waitFor(() => expect(names(container)).toEqual(["pdf", "zip", "csv"]));
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
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf"]));
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
    expect(await screen.findByText(/uncheck .Used only. to browse all 1/i)).toBeTruthy();
  });

  it("refetches inventory scoped to a project when the scope changes", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url); calls.push(u);
      if (u.includes("/api/inventory")) return ({ ok: true, status: 200, text: async () => JSON.stringify(
        u.includes("projects=") ? { skills: [{ name: "proj-skill" }], mcpServers: [], instructions: [], hooks: [] }
                                : { skills: [{ name: "global-skill" }], mcpServers: [], instructions: [], hooks: [] }) }) as unknown as Response;
      if (u.includes("/api/usage")) return ({ ok: true, status: 200, text: async () => JSON.stringify({
        artifacts: [
          { type: "skill", name: "global-skill", invocations: 1, lastUsedMs: 100 },
          { type: "skill", name: "proj-skill", invocations: 1, lastUsedMs: 100 },
        ],
      }) }) as unknown as Response;
      if (u.includes("/api/testbed/projects")) return ({ ok: true, status: 200, text: async () => JSON.stringify({ projects: [{ path: "/home/me/proj", flavor: "claude", lastUsed: null, exists: true }] }) }) as unknown as Response;
      return ({ ok: true, status: 200, text: async () => "{}" }) as unknown as Response;
    }));
    render(<Curate apiBase="" />);
    expect(await screen.findByText("global-skill")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("scope"), { target: { value: "/home/me/proj" } });
    expect(await screen.findByText("proj-skill")).toBeTruthy();
  });
});
