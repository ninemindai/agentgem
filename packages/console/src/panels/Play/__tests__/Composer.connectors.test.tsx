// packages/console/src/panels/Play/__tests__/Composer.connectors.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playBlankRoute, playMcpCandidatesRoute, playMcpCandidateToolsRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const agents = [{ id: "codex", name: "Codex", available: true }];
const renderComposer = (onCreated: (name: string, seedPrompt?: string) => void) =>
  render(<Composer apiBase="" agents={agents} agentId="codex" onAgentIdChange={() => {}} onCreated={onCreated} />);

describe("Composer connector picker", () => {
  it("lists candidates and lazily loads tools on expand, toggling aria-expanded", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [{ server: "github", transport: "stdio", needsSecret: false }] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [{ name: "list_prs" }] } as never);
    renderComposer(vi.fn());

    await waitFor(() => expect(screen.getByText("github")).toBeTruthy());
    const toggle = screen.getByRole("button", { name: /github tools/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(tools).not.toHaveBeenCalled();                 // lazy: no connect until expand

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByText(/list_prs/)).toBeTruthy());
    expect(tools).toHaveBeenCalledTimes(1);
  });

  it("carries a connector preamble to onCreated when a server is checked and a source seeds", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [{ server: "github", transport: "stdio", needsSecret: false }] } as never);
    vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "g1" } as never);
    const onCreated = vi.fn();
    renderComposer(onCreated);

    await waitFor(() => expect(screen.getByText("github")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("github"));      // the checkbox, labelled by the server name
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "x" } });
    fireEvent.click(screen.getByText("Create miniapp"));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(String(onCreated.mock.calls[0][1])).toMatch(/mcpNeeds[\s\S]*- github/);
  });

  it("does not connect on expand when the candidate needs a secret", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(playMcpCandidatesRoute, "call").mockResolvedValue({ servers: [{ server: "pg", transport: "http", needsSecret: true }] } as never);
    const tools = vi.spyOn(playMcpCandidateToolsRoute, "call").mockResolvedValue({ tools: [] } as never);
    renderComposer(vi.fn());

    await waitFor(() => expect(screen.getByText("pg")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /pg tools/i }));
    await waitFor(() => expect(screen.getByText(/set it in your env/i)).toBeTruthy());
    expect(tools).not.toHaveBeenCalled();
  });
});
