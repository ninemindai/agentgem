import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

afterEach(() => { cleanup(); window.location.hash = ""; vi.unstubAllGlobals(); });

describe("Setup", () => {
  it("shows collapsed group headers for each inventory type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText("Skills")).toBeTruthy();
    expect(screen.getByText("Subagents")).toBeTruthy();
    expect(screen.getByText("MCP servers")).toBeTruthy();
    expect(screen.getByText("Hooks")).toBeTruthy();
    expect(screen.getByText("Instructions")).toBeTruthy();
    // collapsed by default — items are not rendered yet
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("expands a group on click to reveal its artifacts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("Skills"));
    expect(screen.getByText("brainstorming")).toBeTruthy();
  });

  it("opens a viewer rendering the artifact's markdown content", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("Skills"));
    fireEvent.click(screen.getByText("brainstorming"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/full skill body/)).toBeTruthy(); // rendered via ContentView
  });

  it("shows config for an artifact with no content (MCP server)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("MCP servers"));
    fireEvent.click(screen.getByText("github"));
    expect(screen.getByText(/"url": "x"/)).toBeTruthy();
  });

  it("auto-expands and filters by the ?q= hash param on mount", async () => {
    window.location.hash = "#/setup?q=code-reviewer";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText("code-reviewer")).toBeTruthy(); // shown without manual expand
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("filters as you type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    await screen.findByText("Skills");
    fireEvent.change(screen.getByLabelText(/filter setup/i), { target: { value: "github" } });
    expect(screen.getByText("github")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });
});
