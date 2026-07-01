import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Curate } from "./index.js";
import { setPendingPlaybook, setPendingContribution } from "../../pendingAnalyze.js";

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

  it("sorts by last used desc when the section 'Last used' header is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByText("Last used"));
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf", "csv"]));
  });

  it("sorts a section by Name when the 'Name' column header is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.click(screen.getByText("Name"));
    // desc (Z→A): zip, pdf, csv
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf", "csv"]));
    // click again → asc (A→Z)
    fireEvent.click(screen.getByText(/^Name/));
    await waitFor(() => expect(names(container)).toEqual(["csv", "pdf", "zip"]));
  });

  it("clears the search query with the × button", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "zip" } });
    await waitFor(() => expect(names(container)).toEqual(["zip"]));
    fireEvent.click(screen.getByLabelText("clear search"));
    await waitFor(() => expect(names(container)).toHaveLength(3));
  });

  it("views an artifact's content inline via the eye button", async () => {
    vi.stubGlobal("fetch", mockFetch());
    render(<Curate apiBase="" />);
    await screen.findByText("pdf");
    expect(screen.queryByText("PDF-SKILL-BODY")).toBeNull();
    fireEvent.click(screen.getByLabelText("view"));
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

  it("playbook hand-off with lessons pre-selects instruction keys so buildSelection includes them", async () => {
    // Prime the one-shot playbook hand-off (simulates the Insights panel handing off to Curate).
    setPendingPlaybook({ root: "/proj", skills: ["ship-loop"], lessons: ["lesson-one"] });

    const workspaceBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/inventory"))
        return res({ skills: [{ name: "ship-loop" }], mcpServers: [], instructions: [{ name: "lesson-one", content: "be concise" }], hooks: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      if (u.includes("/api/workspaces")) {
        workspaceBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return res({ name: "my-gem" });
      }
      throw new Error(`unexpected url ${u}`);
    }));

    render(<Curate apiBase="" />);
    // The mount effect fires on render: 1 skill + 1 instruction = 2 selected.
    await waitFor(() => expect(screen.getByText("2 selected")).toBeTruthy());

    // Save to workspace and confirm the selection body carries the named lesson.
    fireEvent.change(screen.getByLabelText("workspace name"), { target: { value: "my-gem" } });
    fireEvent.click(screen.getByText("Save workspace"));
    await waitFor(() => expect(screen.getByText(/saved workspace/i)).toBeTruthy());

    expect(workspaceBodies[0]).toMatchObject({ selection: { skills: ["ship-loop"], instructions: ["lesson-one"] } });
  });

  it("a ready contribution (Share my setup) pre-selects its keys and opens the Publish form", async () => {
    // Simulates the Inspect "Share my setup" on-ramp handing off a whole-inventory selection.
    setPendingContribution({
      keys: ["skills::pdf", "mcpServers::db", "instructions::house-rules", "hooks::lint"],
      skillCount: 1, lessonCount: 0, name: "my-setup",
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory")) return res({ skills: [{ name: "pdf" }], mcpServers: [{ name: "db" }], instructions: [{ name: "house-rules" }], hooks: [{ name: "lint" }] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      if (u.includes("/api/bind")) return res({ bound: false });
      throw new Error(`unexpected url ${u}`);
    }));

    render(<Curate apiBase="" />);
    // All four handed-off keys are pre-selected…
    await waitFor(() => expect(screen.getByText("4 selected")).toBeTruthy());
    // …and the Publish-to-Explore form is open so the user can share it out.
    expect(screen.getByText("Share to Explore")).toBeTruthy();
    // Default workspace name was applied from the contribution.
    expect((screen.getByLabelText("workspace name") as HTMLInputElement).value).toBe("my-setup");
  });

});
