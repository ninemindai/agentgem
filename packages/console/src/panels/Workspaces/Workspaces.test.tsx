import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Workspaces, countChips } from "./index.js";

afterEach(cleanup);

const res = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const ws = {
  name: "my-ws",
  gemName: "starter",
  version: "1.2.0",
  artifactCounts: { skill: 3, mcp_server: 1, instructions: 2, hook: 0 },
  checks: 4,
  renderedTargets: ["claude", "codex"],
};

describe("countChips", () => {
  it("maps artifact counts + checks to ordered chips", () => {
    expect(countChips(ws as any)).toEqual([
      { label: "skills", n: 3 },
      { label: "MCP", n: 1 },
      { label: "instructions", n: 2 },
      { label: "hooks", n: 0 },
      { label: "checks", n: 4 },
    ]);
  });
});

describe("Workspaces", () => {
  it("renders a card per workspace with gem, counts, and targets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces: [ws] })));
    const { container } = render(<Workspaces apiBase="" />);
    expect(await screen.findByText("my-ws")).toBeTruthy();
    expect(screen.getByText("starter@1.2.0")).toBeTruthy();
    expect(screen.getByText("3 skills")).toBeTruthy();
    const targetChips = Array.from(container.querySelectorAll(".ws-target")).map((n) => n.textContent);
    expect(targetChips).toEqual(["claude", "codex"]);
  });

  it("shows an empty state when there are no workspaces", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ workspaces: [] })));
    render(<Workspaces apiBase="" />);
    expect(await screen.findByText(/no saved workspaces/i)).toBeTruthy();
  });

  it("renders a workspace to a target", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/workspace/render")) return res({ target: "claude", path: "/runs/my-ws/claude" });
      return res({ workspaces: [ws] });
    }));
    render(<Workspaces apiBase="" />);
    await screen.findByText("my-ws");
    fireEvent.click(screen.getByText("Render"));
    await waitFor(() => expect(screen.getByText(/rendered claude → \/runs\/my-ws\/claude/)).toBeTruthy());
  });

  it("deletes a workspace and refreshes", async () => {
    let deleted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/api/workspace/delete")) { deleted = true; return res({ deleted: "my-ws" }); }
      return res({ workspaces: deleted ? [] : [ws] });
    }));
    render(<Workspaces apiBase="" />);
    await screen.findByText("my-ws");
    fireEvent.click(screen.getByText("Delete"));
    await waitFor(() => expect(screen.getByText(/no saved workspaces/i)).toBeTruthy());
  });
});
