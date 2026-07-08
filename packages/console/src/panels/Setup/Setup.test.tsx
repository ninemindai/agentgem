import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Setup } from "./index.js";

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const inv = {
  skills: [{ type: "skill", name: "brainstorming", source: "superpowers", description: "explore intent", content: "# Brainstorming\nfull skill body" }],
  subagents: [{ type: "subagent", name: "code-reviewer", source: "pr-review-toolkit", content: "reviewer agent body" }],
  mcpServers: [{ type: "mcpServer", name: "github", transport: "http", config: { url: "x" } }],
  hooks: [{ type: "hook", name: "onstop", event: "Stop", config: {} }],
  instructions: [{ type: "instruction", name: "CLAUDE.md", content: "be concise" }],
};

const setHash = (h: string) => act(() => {
  window.location.hash = h;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});

afterEach(() => { cleanup(); window.location.hash = ""; vi.unstubAllGlobals(); });

describe("Setup", () => {
  it("renders a tab per artifact type, each carrying its count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByRole("tab", { name: "All" })).toBeTruthy();
    for (const label of ["Skills", "Subagents", "MCP servers", "Hooks", "Instructions"])
      expect(screen.getByRole("tab", { name: new RegExp(label) })).toBeTruthy();
    // Skills tab shows its count "1"
    expect(screen.getByRole("tab", { name: /Skills/ }).textContent).toContain("1");
  });

  it("shows an overview index card per type with its top artifacts on the All tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    // Top names surface directly on the cards — no expand needed.
    expect(await screen.findByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("github")).toBeTruthy();
  });

  it("deep-links an artifact to a stable URL when clicked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("brainstorming"));
    expect(window.location.hash).toBe("#/setup/skills?a=brainstorming");
  });

  it("opens the viewer for an artifact addressed by #/setup/<tab>?a=<name>", async () => {
    window.location.hash = "#/setup/skills?a=brainstorming";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/full skill body/)).toBeTruthy(); // rendered via ContentView
    expect(screen.getByRole("button", { name: /copy link/i })).toBeTruthy();
  });

  it("shows config for an artifact with no content (MCP server)", async () => {
    window.location.hash = "#/setup/mcp?a=github";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText(/"url": "x"/)).toBeTruthy();
  });

  it("switches to a type tab, scoping the list to that type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Skills/ }));
    setHash("#/setup/skills"); // jsdom doesn't auto-fire hashchange on assignment
    expect(screen.getByText("brainstorming")).toBeTruthy();
    expect(screen.queryByText("code-reviewer")).toBeNull(); // subagent hidden on the Skills tab
  });

  it("auto-filters across types by the legacy ?q= hash param on mount", async () => {
    window.location.hash = "#/setup?q=code-reviewer";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText("code-reviewer")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("filters as you type on the All tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    await screen.findByRole("tab", { name: "All" });
    fireEvent.change(screen.getByLabelText(/filter setup/i), { target: { value: "github" } });
    expect(screen.getByText("github")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("reflects the active filter in each tab's count badge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    await screen.findByRole("tab", { name: /Skills/ });
    fireEvent.change(screen.getByLabelText(/filter setup/i), { target: { value: "brain" } });
    // "brain" matches the one skill and no subagents — the badges must agree with the lists.
    expect(screen.getByRole("tab", { name: /Skills/ }).textContent).toContain("1");
    expect(screen.getByRole("tab", { name: /Subagents/ }).textContent).toContain("0");
  });

  it("shows a not-found note (and no viewer) for an unresolvable ?a= deep link", async () => {
    window.location.hash = "#/setup/skills?a=ghost";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText(/No artifact named/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull(); // silent no-op is gone
  });

  it("resolves a ?a= link across types when the tab's own type lacks it", async () => {
    window.location.hash = "#/setup/skills?a=github"; // github is an MCP server, not a skill
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/"url": "x"/)).toBeTruthy(); // opened github's config anyway
  });

  it("keeps the list behind an open viewer unfiltered (no 'no matches' under the modal)", async () => {
    window.location.hash = "#/setup/skills?a=brainstorming&q=zzz"; // filter that would exclude it
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText(/No artifacts match/)).toBeNull();
  });
});
