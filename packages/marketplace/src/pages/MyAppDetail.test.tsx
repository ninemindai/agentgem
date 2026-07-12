import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MyAppDetail } from "./MyAppDetail";
import type { Me } from "../auth";

afterEach(() => cleanup());

const me: Me = { id: "u1", name: "octocat", handle: "octocat", avatarUrl: null, orgs: [] };

const privateGem = {
  key: "@octocat/priv-skill",
  version: "1.0.0",
  publishedBy: "octocat",
  description: "a private skill",
  tags: ["a"],
  artifactKinds: ["skill"],
  artifacts: [{ name: "helper", type: "skill" }],
  grade: "A",
  visibility: "private" as const,
  installable: false,
};

const privateGame = { ...privateGem, key: "@octocat/priv-game", artifactKinds: ["game"] };

function apiStub(over: Record<string, unknown> = {}) {
  return {
    getMyGem: vi.fn().mockResolvedValue(privateGem),
    getOwnerGemArchive: vi.fn().mockResolvedValue("aGVsbG8="),
    getOwnerGameMeta: vi.fn().mockResolvedValue({ title: "Priv Game", genre: "project-fun", version: "1.0.0" }),
    getOwnerGameHtml: vi.fn().mockResolvedValue("<!doctype html><title>t</title>"),
    unpublishGem: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

describe("MyAppDetail page", () => {
  it("prompts sign-in when signed out, instead of fetching", async () => {
    const api = apiStub();
    render(<MyAppDetail api={api} me={null} keyName="@octocat/priv-skill" />);
    expect(await screen.findByRole("link", { name: /sign in with github/i })).toBeTruthy();
    expect((api as unknown as { getMyGem: ReturnType<typeof vi.fn> }).getMyGem).not.toHaveBeenCalled();
  });

  it("renders the visibility badge, description, and contents for a private gem", async () => {
    render(<MyAppDetail api={apiStub()} me={me} keyName="@octocat/priv-skill" />);
    expect(await screen.findByText("@octocat/priv-skill")).toBeTruthy();
    expect(screen.getByText("Private")).toBeTruthy();
    expect(screen.getByText("a private skill")).toBeTruthy();
    expect(screen.getByText("helper")).toBeTruthy();
    expect(screen.getByRole("button", { name: /download \.gem/i })).toBeTruthy();
  });

  it("does not show the npx install command for a private (non-installable) gem", async () => {
    render(<MyAppDetail api={apiStub()} me={me} keyName="@octocat/priv-skill" />);
    await screen.findByText("@octocat/priv-skill");
    expect(screen.queryByText(/npx @ninemind\/agentgem get/)).toBeNull();
  });

  it("Download .gem fetches the owner-gated archive", async () => {
    const api = apiStub();
    render(<MyAppDetail api={api} me={me} keyName="@octocat/priv-skill" />);
    fireEvent.click(await screen.findByRole("button", { name: /download \.gem/i }));
    await waitFor(() => expect((api as unknown as { getOwnerGemArchive: ReturnType<typeof vi.fn> }).getOwnerGemArchive)
      .toHaveBeenCalledWith("@octocat/priv-skill", "1.0.0"));
  });

  it("shows a not-found state when getMyGem rejects with a 404", async () => {
    const api = apiStub({ getMyGem: vi.fn().mockRejectedValue(new Error("/api/catalog/gem-detail -> 404")) });
    render(<MyAppDetail api={api} me={me} keyName="does-not-exist" />);
    expect(await screen.findByText(/not found or not yours/i)).toBeTruthy();
  });

  it("shows a game's Play control and resolves owner-only meta+html into a sealed player", async () => {
    const api = apiStub({ getMyGem: vi.fn().mockResolvedValue(privateGame) });
    render(<MyAppDetail api={api} me={me} keyName="@octocat/priv-game" />);
    const playButton = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(playButton);

    await waitFor(() => expect((api as unknown as { getOwnerGameMeta: ReturnType<typeof vi.fn> }).getOwnerGameMeta)
      .toHaveBeenCalledWith("@octocat/priv-game"));
    await waitFor(() => expect((api as unknown as { getOwnerGameHtml: ReturnType<typeof vi.fn> }).getOwnerGameHtml)
      .toHaveBeenCalledWith("@octocat/priv-game", "1.0.0"));
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });

  it("a non-game gem gets no Play control", async () => {
    render(<MyAppDetail api={apiStub()} me={me} keyName="@octocat/priv-skill" />);
    await screen.findByText("@octocat/priv-skill");
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  });

  it("unpublish confirms, calls the API, and navigates to /my-apps on success", async () => {
    const api = apiStub();
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<MyAppDetail api={api} me={me} keyName="@octocat/priv-skill" />);
    fireEvent.click(await screen.findByRole("button", { name: /unpublish/i }));
    await waitFor(() => expect((api as unknown as { unpublishGem: ReturnType<typeof vi.fn> }).unpublishGem)
      .toHaveBeenCalledWith("@octocat/priv-skill", "1.0.0"));
    await waitFor(() => expect(window.location.pathname).toBe("/my-apps"));
    vi.unstubAllGlobals();
  });
});
