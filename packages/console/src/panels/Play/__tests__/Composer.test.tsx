// packages/console/src/panels/Play/__tests__/Composer.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "../Composer.js";
import { testbedProjectsRoute, playStudioRoute, playImportRoute, playBlankRoute, inventoryRoute } from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const agents = [{ id: "codex", name: "Codex", available: true }, { id: "claude-code", name: "Claude Code", available: true }];
const renderComposer = (onCreated: (name: string, seedPrompt?: string) => void) =>
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

  // The Session tab defaults to Replay; the default seed call must stay byte-identical (no `genre` key)
  // so existing behavior is unaffected by the new control.
  it("Session tab defaults to Replay and omits genre from the seed call", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "s1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [{ id: "sess-1", file: "/f", agent: "claude", project: "app", model: "opus", msgs: 5, startMs: 0, endMs: 1, ageMs: 1 }] }) })) as unknown as typeof fetch);
    renderComposer(vi.fn());
    fireEvent.click(screen.getByText("Session"));
    await waitFor(() => expect(screen.getByText("app")).toBeTruthy());
    fireEvent.click(screen.getByText("app"));
    await waitFor(() => expect(studio).toHaveBeenCalled());
    expect(JSON.stringify(studio.mock.calls[0][1])).not.toContain("genre");
  });

  // Picking Heatmap threads `genre: "session-heatmap"` into the seed call.
  it("Session tab threads session-heatmap genre when the user picks Heatmap", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "s1" });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ sessions: [{ id: "sess-1", file: "/f", agent: "claude", project: "app", model: "opus", msgs: 5, startMs: 0, endMs: 1, ageMs: 1 }] }) })) as unknown as typeof fetch);
    renderComposer(vi.fn());
    fireEvent.click(screen.getByText("Session"));
    await waitFor(() => expect(screen.getByText("app")).toBeTruthy());
    fireEvent.click(screen.getByText("Heatmap"));
    fireEvent.click(screen.getByText("app"));
    await waitFor(() => expect(studio).toHaveBeenCalled());
    expect(studio.mock.calls[0][1]).toMatchObject({ body: { genre: "session-heatmap" } });
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

  it("switches to the Blank tab and threads the description to the studio as a seed prompt", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const blank = vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "space-dodger" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Space Dodger" } });
    fireEvent.change(screen.getByPlaceholderText(/describe the mini-game/i), { target: { value: "dodge asteroids" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    // The description is threaded to onCreated (auto-sent as the studio's first prompt), NOT baked server-side.
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("space-dodger", "dodge asteroids"));
    expect(blank.mock.calls[0][1]).toEqual({ body: { title: "Space Dodger" } });
  });

  it("threads attached docs/photos into the first studio prompt", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const blank = vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "brand-clicker" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByLabelText("Add reference docs/photos"), {
      target: { files: [new File(["Make it use the acme brand colors."], "brief.md", { type: "text/markdown" })] },
    });
    expect(await screen.findByText(/brief\.md/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Brand Clicker" } });
    fireEvent.change(screen.getByPlaceholderText(/describe the mini-game/i), { target: { value: "click targets" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const seedPrompt = onCreated.mock.calls[0][1] as string;
    expect(seedPrompt).toContain("Document: brief.md");
    expect(seedPrompt).toContain("Make it use the acme brand colors.");
    expect(seedPrompt).toContain("click targets");
    expect(blank.mock.calls[0][1]).toEqual({ body: { title: "Brand Clicker" } });
  });

  it("Blank tab threads no seed prompt when the description is left empty", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
    const blank = vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "untitled" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Untitled" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("untitled", undefined));
    expect(blank.mock.calls[0][1]).toEqual({ body: { title: "Untitled" } });
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

  // The marketplace "Make your own" deep link arrives with a title + prompt; the reader should land on
  // Blank (not the default Project tab) with both fields filled and Create enabled.
  it("opens on the Blank tab prefilled when seeded from a deep link", async () => {
    const blank = vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "duel-remix" });
    const onCreated = vi.fn();
    render(<Composer apiBase="" agents={agents} agentId="codex" onAgentIdChange={() => {}}
      initialTitle="duel-remix" initialPrompt="Build my own version" onCreated={onCreated} />);
    expect(screen.getByPlaceholderText("title")).toHaveProperty("value", "duel-remix");
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("duel-remix", "Build my own version"));
    expect(blank.mock.calls[0][1]).toEqual({ body: { title: "duel-remix" } });  // no name typed -> field omitted
  });

  // A typed name is the miniapp's id. Omitted, the server derives one; supplied, it must be free.
  it("sends a typed name on blank, and omits it when left empty", async () => {
    const blank = vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "my-duel" });
    renderComposer(vi.fn());
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Anything" } });
    fireEvent.change(screen.getByLabelText("Miniapp name"), { target: { value: "My Duel" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(blank).toHaveBeenCalled());
    expect(blank.mock.calls[0][1]).toEqual({ body: { title: "Anything", name: "My Duel" } });
  });

  it("carries the typed name onto a source-seeded miniapp too", async () => {
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }] } as never);
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "chosen" });
    renderComposer(vi.fn());
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Miniapp name"), { target: { value: "chosen" } });
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(studio).toHaveBeenCalled());
    expect(studio.mock.calls[0][1]).toMatchObject({ body: { name: "chosen" } });
  });

  it("surfaces a taken-name conflict instead of silently renaming", async () => {
    vi.spyOn(playBlankRoute, "call").mockRejectedValue(new Error("miniapp already exists: 'my-duel'"));
    renderComposer(vi.fn());
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "Anything" } });
    fireEvent.change(screen.getByLabelText("Miniapp name"), { target: { value: "my-duel" } });
    fireEvent.click(screen.getByText("Create miniapp"));
    await waitFor(() => expect(screen.getByText(/already exists/i)).toBeTruthy());
  });
});

describe("Composer capability checkboxes", () => {
  const stubProjects = () =>
    vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({
      projects: [{ path: "/p/demo", flavor: "node", lastUsed: null, exists: true }],
    } as never);

  it("passes a capability preamble as the seed prompt when a box is checked", async () => {
    stubProjects();
    vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/watch your live coding sessions in real time/i));
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const seedPrompt = onCreated.mock.calls[0][1] as string;
    expect(seedPrompt).toContain("agentgem_subscribe_sessions");
    expect(seedPrompt).toContain("live-session-events");
  });

  it("passes no seed prompt when nothing is checked", async () => {
    stubProjects();
    vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onCreated.mock.calls[0][1]).toBeUndefined();
  });

  it("never sends needs to the server — checkboxes are intent, not declaration", async () => {
    stubProjects();
    const studio = vi.spyOn(playStudioRoute, "call").mockResolvedValue({ name: "demo" });
    renderComposer(vi.fn());
    await waitFor(() => expect(screen.getByText("/p/demo")).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/run a local AI agent on your machine/i));
    fireEvent.click(screen.getByText("/p/demo"));
    await waitFor(() => expect(studio).toHaveBeenCalled());
    expect(JSON.stringify(studio.mock.calls[0][1])).not.toContain("needs");
  });

  it("combines the preamble with the Blank tab description", async () => {
    stubProjects();
    vi.spyOn(playBlankRoute, "call").mockResolvedValue({ name: "my-app" });
    const onCreated = vi.fn();
    renderComposer(onCreated);
    fireEvent.click(screen.getByText("Blank"));
    fireEvent.change(screen.getByPlaceholderText("title"), { target: { value: "My App" } });
    fireEvent.change(screen.getByPlaceholderText(/describe the mini-game/i), { target: { value: "a dashboard" } });
    fireEvent.click(screen.getByLabelText(/read your local setup/i));
    fireEvent.click(screen.getByRole("button", { name: /Create miniapp/ }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const seedPrompt = onCreated.mock.calls[0][1] as string;
    expect(seedPrompt).toContain("agentgem_get_inventory");
    expect(seedPrompt).toContain("a dashboard");
  });
});
