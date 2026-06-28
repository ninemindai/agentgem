import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { ActiveGemSwitcher, gemLabel } from "./ActiveGemSwitcher.js";
import { getName, getKeys, setName, resetGem } from "../activeGem.js";

afterEach(() => { cleanup(); resetGem(); window.location.hash = ""; vi.unstubAllGlobals(); });

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

// Server returns workspaces already recency-ordered (most-recent first).
const workspaces = [
  { name: "fresh", gemName: "fresh", version: "1.0.0", artifactCounts: { skill: 2, mcp_server: 0, instructions: 0, hook: 0 },
    artifacts: [{ type: "skill", name: "pdf" }, { type: "skill", name: "csv" }], modifiedMs: 3000, checks: 0, renderedTargets: [] },
  { name: "older", gemName: "older", version: "1.0.0", artifactCounts: { skill: 0, mcp_server: 1, instructions: 0, hook: 0 },
    artifacts: [{ type: "mcp_server", name: "context7" }], modifiedMs: 1000, checks: 0, renderedTargets: [] },
];

describe("gemLabel", () => {
  it("is the gem name when set", () => expect(gemLabel("My Gem", 5)).toBe("My Gem"));
  it("is 'New Gem' (no count) when empty and nothing selected", () => expect(gemLabel("", 0)).toBe("New Gem"));
  it("counts artifacts (pluralized) for an unnamed in-progress gem", () => {
    expect(gemLabel("", 1)).toBe("New Gem · 1 artifact");
    expect(gemLabel("", 3)).toBe("New Gem · 3 artifacts");
  });
});

describe("ActiveGemSwitcher", () => {
  it("opens to list recent gems in server (recency) order", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces })));
    render(<ActiveGemSwitcher apiBase="" />);
    fireEvent.click(screen.getByText("New Gem"));
    await screen.findByText("fresh");
    const names = screen.getAllByRole("menuitem")
      .map((b) => b.querySelector(".console-switcher-name")?.textContent)
      .filter(Boolean);
    expect(names).toEqual(["fresh", "older"]); // most-recent first, server order preserved
  });

  it("opening a recent gem restores its name + selection and routes to curate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces })));
    render(<ActiveGemSwitcher apiBase="" />);
    fireEvent.click(screen.getByText("New Gem"));
    fireEvent.click(await screen.findByText("fresh"));
    expect(getName()).toBe("fresh");
    expect([...getKeys()].sort()).toEqual(["skills::csv", "skills::pdf"]);
    expect(window.location.hash).toBe("#/curate");
  });

  it("＋ New Gem resets the active gem and routes to curate", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces })));
    setName("prev");
    render(<ActiveGemSwitcher apiBase="" />);
    fireEvent.click(screen.getByText("prev"));
    fireEvent.click(await screen.findByText("＋ New Gem"));
    expect(getName()).toBe("");
    expect(window.location.hash).toBe("#/curate");
  });

  it("Browse all → routes to your-gems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces })));
    render(<ActiveGemSwitcher apiBase="" />);
    fireEvent.click(screen.getByText("New Gem"));
    fireEvent.click(await screen.findByText("Browse all →"));
    expect(window.location.hash).toBe("#/your-gems");
  });

  it("shows an empty state when there are no saved gems", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces: [] })));
    render(<ActiveGemSwitcher apiBase="" />);
    fireEvent.click(screen.getByText("New Gem"));
    await waitFor(() => expect(screen.getByText(/no saved gems yet/i)).toBeTruthy());
  });
});
