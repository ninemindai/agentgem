// packages/console/src/panels/Play/__tests__/ConnectorPicker.test.tsx
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ConnectorPicker, connectorPreamble } from "../ConnectorPicker.js";
import { playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ConnectorPicker", () => {
  it("connectorPreamble lists checked servers", () => {
    expect(connectorPreamble([])).toBe("");
    expect(connectorPreamble(["github"])).toMatch(/mcpNeeds[\s\S]*- github/);
  });

  it("opens the menu and picks a server (onChange gets the new selection)", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "github", transport: "http", needsSecret: false },
    ] } as never);
    const onChange = vi.fn();
    render(<ConnectorPicker apiBase="" selected={[]} onChange={onChange} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /add connector/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /add connector/i }));
    await waitFor(() => expect(screen.getByText("github")).toBeTruthy());
    fireEvent.click(screen.getByText("github"));
    expect(onChange).toHaveBeenCalledWith(["github"]);
  });

  it("lazily loads a picked server's tools when its chip is expanded", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "github", transport: "http", needsSecret: false },
    ] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [{ name: "list_prs" }] } as never);
    render(<ConnectorPicker apiBase="" selected={["github"]} onChange={vi.fn()} />);
    const chip = await screen.findByRole("button", { name: /github tools/i });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(tools).not.toHaveBeenCalled();
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByText(/list_prs/)).toBeTruthy());
    expect(tools).toHaveBeenCalledTimes(1);
  });

  it("does not auto-connect a needs-secret chip on expand", async () => {
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [
      { server: "pg", transport: "http", needsSecret: true },
    ] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [] } as never);
    render(<ConnectorPicker apiBase="" selected={["pg"]} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /pg tools/i }));
    await waitFor(() => expect(screen.getByText(/set it in your env/i)).toBeTruthy());
    expect(tools).not.toHaveBeenCalled();
  });
});
