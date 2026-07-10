import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Curate } from "./index.js";
import { setPendingPlaybook, setPendingContribution } from "../../pendingAnalyze.js";
import { IdentityProvider } from "../../identity/IdentityProvider.js";

// Curate mounts PublishToExplore (which reads useIdentity()) once a hand-off shows
// the publish form, so every render needs the provider in the tree.
const renderCurate = (props: React.ComponentProps<typeof Curate>) =>
  render(<IdentityProvider apiBase=""><Curate {...props} /></IdentityProvider>);

afterEach(cleanup);

// @agentback/client parses responses via `response.text()` + JSON.parse and
// reads `ok`/`status` — so the stub only needs those.
const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

function mockFetch() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/inventory"))
      // pdf carries an id and no content — the shape ?body=defer returns; the panel
      // fetches its body from /api/artifact/content on expand.
      return res({ skills: [{ name: "pdf", id: "workspace/skills/standalone/pdf" }, { name: "csv" }, { name: "zip" }], mcpServers: [], instructions: [], hooks: [], subagents: [] });
    if (u.includes("/api/artifact/content")) {
      const id = new URL(u, "http://localhost").searchParams.get("id") ?? "";
      return res({ id, content: "LAZY-BODY" });
    }
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
    const { container } = renderCurate({ apiBase: "" });
    expect(await screen.findByText("pdf")).toBeTruthy();
    expect(await screen.findByText("7")).toBeTruthy();
    expect(names(container)).toEqual(["pdf", "zip", "csv"]);
  });

  it("defaults to the Compose tab and switches to the Suggest tab", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderCurate({ apiBase: "" });
    await screen.findByText("pdf"); // compose inventory visible by default
    expect((screen.getByRole("tab", { name: "Compose from artifacts" }) as HTMLElement).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Suggest from a project" }));
    expect(await screen.findByText(/agentgem reads its sessions/i)).toBeTruthy(); // analyze intro
    expect(screen.queryByText("pdf")).toBeNull(); // compose inventory hidden
  });

  it("hides zero-use items when 'Used only' is checked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.click(usedOnly());
    await waitFor(() => expect(names(container)).toEqual(["pdf", "zip"]));
  });

  it("filters by search query", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "zip" } });
    await waitFor(() => expect(names(container)).toEqual(["zip"]));
  });

  it("sorts by last used desc when the section 'Last used' header is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.click(screen.getByText("Last used"));
    await waitFor(() => expect(names(container)).toEqual(["zip", "pdf", "csv"]));
  });

  it("sorts a section by Name when the 'Name' column header is clicked", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { container } = renderCurate({ apiBase: "" });
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
    const { container } = renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.change(screen.getByLabelText("search"), { target: { value: "zip" } });
    await waitFor(() => expect(names(container)).toEqual(["zip"]));
    fireEvent.click(screen.getByLabelText("clear search"));
    await waitFor(() => expect(names(container)).toHaveLength(3));
  });

  it("views an artifact's content inline via the eye button", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    expect(screen.queryByText("LAZY-BODY")).toBeNull();
    fireEvent.click(screen.getByLabelText("view"));
    expect(await screen.findByText("LAZY-BODY")).toBeTruthy();
  });

  it("lazily fetches a deferred body on expand, once", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderCurate({ apiBase: "" });
    const view = await screen.findByLabelText("view");   // button renders from `id`, with no body loaded
    fireEvent.click(view);
    expect(await screen.findByText("LAZY-BODY")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("hide"));
    fireEvent.click(screen.getByLabelText("view"));      // re-expand
    await screen.findByText("LAZY-BODY");

    const contentCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/artifact/content"));
    expect(contentCalls).toHaveLength(1);                // memoized: fetched exactly once
  });

  it("clears a stale body-load error once a retry succeeds", async () => {
    // First /api/artifact/content request fails (transient 500); the second (the
    // retry via collapse + re-expand, since bodies[id] is still undefined) succeeds.
    let contentCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/inventory"))
        return res({ skills: [{ name: "pdf", id: "workspace/skills/standalone/pdf" }], mcpServers: [], instructions: [], hooks: [], subagents: [] });
      if (u.includes("/api/artifact/content")) {
        contentCalls += 1;
        if (contentCalls === 1) return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
        const id = new URL(u, "http://localhost").searchParams.get("id") ?? "";
        return res({ id, content: "LAZY-BODY" });
      }
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));
    renderCurate({ apiBase: "" });

    const view = await screen.findByLabelText("view");
    fireEvent.click(view);
    expect(await screen.findByText(/Failed to load/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("hide"));
    fireEvent.click(screen.getByLabelText("view")); // retry via collapse + re-expand

    expect(await screen.findByText("LAZY-BODY")).toBeTruthy();
    expect(screen.queryByText(/Failed to load/)).toBeNull();
  });

  it("suggests checks for the selection", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.click(screen.getByLabelText("pdf"));
    fireEvent.click(screen.getByText("Suggest checks"));
    expect(await screen.findByText("smoke-test")).toBeTruthy();
    expect(screen.getByText("behavioral")).toBeTruthy();
  });

  it("saves the current selection as a workspace", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderCurate({ apiBase: "" });
    await screen.findByText("pdf");
    fireEvent.click(screen.getByLabelText("pdf"));
    fireEvent.change(screen.getByLabelText("workspace name"), { target: { value: "my-selection" } });
    fireEvent.click(screen.getByText("Save workspace"));
    await waitFor(() => expect(screen.getByText(/saved workspace .my-selection./)).toBeTruthy());
  });

  it("clears the selection", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderCurate({ apiBase: "" });
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
        return res({ skills: [{ name: "pdf" }], mcpServers: [], instructions: [], hooks: [], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));
    renderCurate({ apiBase: "" });
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
        return res({ skills: [{ name: "ship-loop" }], mcpServers: [], instructions: [{ name: "lesson-one", content: "be concise" }], hooks: [], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      if (u.includes("/api/workspaces")) {
        workspaceBodies.push(JSON.parse((init?.body as string) ?? "{}"));
        return res({ name: "my-gem" });
      }
      throw new Error(`unexpected url ${u}`);
    }));

    renderCurate({ apiBase: "" });
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
      if (u.includes("/api/inventory")) return res({ skills: [{ name: "pdf" }], mcpServers: [{ name: "db" }], instructions: [{ name: "house-rules" }], hooks: [{ name: "lint" }], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      if (u.includes("/api/bind")) return res({ bound: false });
      throw new Error(`unexpected url ${u}`);
    }));

    renderCurate({ apiBase: "" });
    // All four handed-off keys are pre-selected…
    await waitFor(() => expect(screen.getByText("4 selected")).toBeTruthy());
    // …and the Publish-to-Explore form is open so the user can share it out.
    // (heading role disambiguates from the identically-labelled submit button)
    expect(screen.getByRole("heading", { name: "Publish to Explore" })).toBeTruthy();
    // Default workspace name was applied from the contribution.
    expect((screen.getByLabelText("workspace name") as HTMLInputElement).value).toBe("my-setup");
  });

  it("root-only playbook hand-off distills in Curate, then opens the prefilled Publish form", async () => {
    // The Insights "Publish" button now navigates instantly with just the project root;
    // Curate runs the (slow) distill itself with progress, then shows the publish form.
    setPendingPlaybook({ root: "/work/myproj" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/playbook/prepare")) return res({ skills: ["ship-loop"], lessons: ["lesson-one"], root: "/work/myproj", degraded: false, preparing: false });
      if (u.includes("/api/inventory")) return res({ skills: [{ name: "ship-loop" }], mcpServers: [], instructions: [{ name: "lesson-one" }], hooks: [], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      if (u.includes("/api/bind")) return res({ bound: false });
      throw new Error(`unexpected url ${u}`);
    }));

    renderCurate({ apiBase: "" });
    // The publish form appears after the distill, prefilled with the project basename.
    expect(await screen.findByRole("heading", { name: "Publish to Explore" })).toBeTruthy();
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("myproj");
    // 1 skill + 1 lesson distilled → 2 selected.
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("root-only playbook with an empty distill shows an empty state, not the Publish form", async () => {
    setPendingPlaybook({ root: "/work/empty" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/playbook/prepare")) return res({ skills: [], lessons: [], root: "/work/empty", degraded: true, preparing: false });
      if (u.includes("/api/inventory")) return res({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));

    renderCurate({ apiBase: "" });
    expect(await screen.findByText(/nothing distilled worth publishing/i)).toBeTruthy();
    // No hollow gem: the Publish form must not render for an empty distill.
    expect(screen.queryByRole("heading", { name: "Publish to Explore" })).toBeNull();
  });

  it("shows a background 'distilling' state while the heavy distill runs (preparing), not the form", async () => {
    setPendingPlaybook({ root: "/work/slow" });
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      // Cold cache: the server kicked off the background distill and says "preparing".
      if (u.includes("/api/playbook/prepare")) return res({ skills: [], lessons: [], root: "/work/slow", degraded: false, preparing: true });
      if (u.includes("/api/inventory")) return res({ skills: [], mcpServers: [], instructions: [], hooks: [], subagents: [] });
      if (u.includes("/api/usage")) return res({ artifacts: [] });
      throw new Error(`unexpected url ${u}`);
    }));

    renderCurate({ apiBase: "" });
    // While the background distill runs, show progress + set expectations — not the form, not an empty state.
    expect(await screen.findByText(/first run can take a few minutes/i)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Publish to Explore" })).toBeNull();
    expect(screen.queryByText(/nothing distilled worth publishing/i)).toBeNull();
  });

});
