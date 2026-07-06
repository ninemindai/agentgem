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
  it("lists inventory artifacts across groups", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("code-reviewer")).toBeTruthy();
    expect(screen.getByText("github")).toBeTruthy();
    expect(screen.getByText("onstop")).toBeTruthy();
  });

  it("opens a viewer showing the artifact's content on click", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("brainstorming"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/full skill body/)).toBeTruthy();
  });

  it("shows config for an artifact with no content (MCP server)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    fireEvent.click(await screen.findByText("github"));
    expect(screen.getByText(/"url": "x"/)).toBeTruthy();
  });

  it("filters by the ?q= hash param on mount", async () => {
    window.location.hash = "#/setup?q=code-reviewer";
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    expect(await screen.findByText("code-reviewer")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("filters as you type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res(inv)));
    render(<Setup apiBase="" />);
    await screen.findByText("brainstorming");
    fireEvent.change(screen.getByLabelText(/filter setup/i), { target: { value: "github" } });
    expect(screen.getByText("github")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });
});
