import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { MyApps } from "./MyApps";
import type { Me } from "../auth";

afterEach(() => cleanup());

const me: Me = { id: "u1", name: "octocat", handle: "octocat", avatarUrl: null, orgs: [] };

const gems = [
  { key: "@octocat/pub-game", version: "1.0.0", description: "a public game", artifactKinds: ["game"], visibility: "public" as const, installable: true },
  { key: "@octocat/unlisted-game", version: "1.0.0", description: "an unlisted game", artifactKinds: ["game"], visibility: "unlisted" as const, installable: true },
  { key: "@octocat/priv-game", version: "1.0.0", description: "a private game", artifactKinds: ["game"], visibility: "private" as const, installable: false },
  { key: "@octocat/priv-skill", version: "1.0.0", description: "a private skill", artifactKinds: ["skill"], visibility: "private" as const, installable: false },
];

function apiStub(over: Record<string, unknown> = {}) {
  return {
    getMyGems: vi.fn().mockResolvedValue({ gems }),
    getOwnerGameMeta: vi.fn().mockResolvedValue({ title: "Priv Game", genre: "project-fun", version: "1.0.0" }),
    getOwnerGameHtml: vi.fn().mockResolvedValue("<!doctype html><title>t</title>"),
    ...over,
  } as never;
}

describe("MyApps page", () => {
  it("prompts sign-in when signed out, instead of fetching", async () => {
    const api = apiStub();
    render(<MyApps api={api} me={null} />);
    expect(await screen.findByRole("link", { name: /sign in with github/i })).toBeTruthy();
    expect((api as unknown as { getMyGems: ReturnType<typeof vi.fn> }).getMyGems).not.toHaveBeenCalled();
  });

  it("lists the owner's gems across every visibility with a badge each", async () => {
    render(<MyApps api={apiStub()} me={me} />);
    expect(await screen.findByText("@octocat/pub-game")).toBeTruthy();
    expect(await screen.findByText("@octocat/unlisted-game")).toBeTruthy();
    expect(await screen.findByText("@octocat/priv-game")).toBeTruthy();
    expect(await screen.findByText("@octocat/priv-skill")).toBeTruthy();
    expect(screen.getByText("Public")).toBeTruthy();
    expect(screen.getByText("Unlisted")).toBeTruthy();
    expect(screen.getAllByText("Private").length).toBe(2);
  });

  it("Details links to /gems/ only for the public gem — /gems/ 404s unlisted and private (listCatalogGems filters visibility = public)", async () => {
    render(<MyApps api={apiStub()} me={me} />);
    const details = await screen.findAllByRole("link", { name: "Details" });
    expect(details.length).toBe(1);
    expect(details[0].getAttribute("href")).toBe("/gems/%40octocat%2Fpub-game");
  });

  it("public/unlisted games link straight to the shareable /games/ path, no fetch needed", async () => {
    render(<MyApps api={apiStub()} me={me} />);
    const pubPlay = await screen.findAllByRole("link", { name: "Play" });
    expect(pubPlay.map((a) => a.getAttribute("href"))).toEqual(
      expect.arrayContaining(["/games/@octocat/pub-game", "/games/@octocat/unlisted-game"]),
    );
  });

  it("a non-game gem gets no Play control", async () => {
    render(<MyApps api={apiStub()} me={me} />);
    await screen.findByText("@octocat/priv-skill");
    // Only the two public/unlisted games (links) + the one private game (button) ever get a Play control.
    expect(screen.getAllByText("Play").length).toBe(3);
  });

  it("private game: Play resolves owner-only meta+html and renders the sealed player", async () => {
    const api = apiStub();
    render(<MyApps api={api} me={me} />);
    const playButton = await screen.findByRole("button", { name: "Play" });
    fireEvent.click(playButton);

    await waitFor(() => expect((api as unknown as { getOwnerGameMeta: ReturnType<typeof vi.fn> }).getOwnerGameMeta)
      .toHaveBeenCalledWith("@octocat/priv-game"));
    await waitFor(() => expect((api as unknown as { getOwnerGameHtml: ReturnType<typeof vi.fn> }).getOwnerGameHtml)
      .toHaveBeenCalledWith("@octocat/priv-game", "1.0.0"));
    await waitFor(() => expect(document.querySelector("iframe[sandbox]")).not.toBeNull());
  });

  it("private game: a failed resolve surfaces an error instead of a blank player", async () => {
    const api = apiStub({ getOwnerGameMeta: vi.fn().mockRejectedValue(new Error("game-meta -> 404")) });
    render(<MyApps api={api} me={me} />);
    fireEvent.click(await screen.findByRole("button", { name: "Play" }));
    expect(await screen.findByText(/Couldn't load that game/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });
});
