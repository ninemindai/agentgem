// packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playBlankRoute, playMcpCandidatesRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Composer + connector combobox", () => {
  it("carries a connector preamble to onCreated when a server is picked and Blank is created", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [{ server: "github", transport: "http", needsSecret: false }] } as never);
    vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "g1" } as never);
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={[{ id: "codex", name: "Codex", available: true }]} agentId="codex" onAgentIdChange={() => {}} onCreated={onCreated} />);

    fireEvent.click(await screen.findByRole("button", { name: /add connector/i }));
    fireEvent.click(await screen.findByText("github"));           // pick into a chip
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create miniapp"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(String(onCreated.mock.calls[0][1])).toMatch(/mcpNeeds[\s\S]*- github/);
  });

  it("expands the Permissions disclosure to reveal capability checkboxes", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [] } as never);
    render(<Composer apiBase="" agents={[]} agentId="" onAgentIdChange={() => {}} onCreated={vi.fn()} />);
    const toggle = screen.getByRole("button", { name: /permissions/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/run a local AI agent/i)).toBeTruthy();
  });
});
