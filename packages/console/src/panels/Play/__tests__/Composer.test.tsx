// packages/console/src/panels/Play/__tests__/Composer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playStudioRoute, playImportRoute, inventoryRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const agents = [{ id: "codex", name: "Codex", available: true }, { id: "claude-code", name: "Claude Code", available: true }];
const renderComposer = (onCreated: (name: string) => void) =>
  render(<Composer apiBase="" agents={agents} agentId="codex" onAgentIdChange={() => {}} onCreated={onCreated} />);

describe("Composer", () => {
  it("lists projects and creates a studio miniapp on pick", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    expect(screen.getByLabelText("coding agent")).toHaveProperty("value", "codex");
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("demo"));
    expect(studio.mock.calls[0][1]).toMatchObject({ body: { source: { kind: "project", path: "/p/demo" } } });
  });

  it("switches to the Session tab and seeds a session source", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "s1" });
    // fetchSessions uses raw fetch → stub the global
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [{ id: "sess-1", file: "/f", agent: "claude", project: "app", model: "opus", msgs: 5, startMs: 0, endMs: 1, ageMs: 1 }] }) })) as unknown as typeof fetch);
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Session"));
    await waitFor(() => expect(screen.getByText("app")).toBeTruthy());
    fireEvent.click(screen.getByText("app"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("s1"));
    expect(studio.mock.calls[0][1]).toMatchObject({ body: { source: { kind: "session", sessionId: "sess-1", agent: "claude" } } });
  });

  it("switches to the HTML tab and imports pasted HTML", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const imp = vi.spyOn(playImportRoute, "call").mockResolvedValue({ name: "my-game" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("HTML"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My Game" } });
    fireEvent.change(screen.getByPlaceholderText("…or paste HTML here"), { target: { value: "<h1>hi</h1>" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("my-game"));
    expect(imp.mock.calls[0][1]).toMatchObject({ body: { title: "My Game", html: "<h1>hi</h1>" } });
  });

  it("switches to the Skill tab and seeds a skill source", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    vi.spyOn(inventoryRoute, "call").mockResolvedValue({ skills: [{ name: "brainstorming", description: "explore ideas" }], mcpServers: [], instructions: [], hooks: [], subagents: [] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "brainstorming" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Skill"));
    await waitFor(() => expect(screen.getByText("brainstorming")).toBeTruthy());
    fireEvent.click(screen.getByText("brainstorming"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("brainstorming"));
    expect(studio.mock.calls[0][1]).toMatchObject({ body: { source: { kind: "skill", skillName: "brainstorming" } } });
  });
});
