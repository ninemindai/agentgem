// packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { Play } from "../index.js";
import { testbedProjectsRoute, playRemixSourceRoute, playImportRoute } from "../../../api/routes.js";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";

afterEach(() => { cleanup(); window.location.hash = ""; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// Play fetches /api/agents on mount; Arcade + Composer's Project tab hit their own routes.
const stubBoot = () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ agents: [], miniapps: [] }) })) as unknown as typeof fetch);
  vi.spyOn(testbedProjectsRoute, "call").mockResolvedValue({ projects: [] } as never);
};

describe("Play deep link (#/play?new=…)", () => {
  it("opens the Composer prefilled from the hash seed", async () => {
    stubBoot();
    window.location.hash = "#/play?new=1&title=duel-remix&prompt=Build%20my%20own";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByPlaceholderText("title")).toHaveProperty("value", "duel-remix"));
    expect(screen.getByPlaceholderText(/describe the mini-game you want/i)).toHaveProperty("value", "Build my own");
  });

  it("stays on the Arcade when the hash carries no seed", async () => {
    stubBoot();
    window.location.hash = "#/play";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByText("+ New miniapp")).toBeTruthy());
    expect(screen.queryByPlaceholderText("title")).toBeNull();
  });

  // Hash-reactive, not mount-only: a second "Make your own" click while Play is already open must
  // re-seed the Composer rather than leave the previous game's prompt sitting there.
  it("re-seeds when a new deep link arrives while already open", async () => {
    stubBoot();
    window.location.hash = "#/play?new=1&title=a-remix&prompt=first";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByPlaceholderText("title")).toHaveProperty("value", "a-remix"));
    act(() => {
      window.location.hash = "#/play?new=1&title=b-remix&prompt=second";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(screen.getByPlaceholderText("title")).toHaveProperty("value", "b-remix"));
  });
});

describe("Play deep link (#/play?remix=…)", () => {
  it("shows the confirm card and fetches NOTHING before the click", async () => {
    stubBoot();
    const srcCall = vi.spyOn(playRemixSourceRoute, "call");
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByText(/Remix .@bob\/snake./)).toBeTruthy());
    expect(srcCall).not.toHaveBeenCalled();
  });

  it("confirming fetches the source and imports the fork with pinned lineage", async () => {
    stubBoot();
    vi.spyOn(playRemixSourceRoute, "call").mockResolvedValue(
      { title: "Snake", genre: "project-fun", version: "1.2.0", html: "<html>x</html>" } as never);
    const importCall = vi.spyOn(playImportRoute, "call").mockResolvedValue({ name: "snake-remix" } as never);
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    // Confirming transitions to Studio, which reads useIdentity() — Shell provides this in
    // production; the standalone <Play> render here needs it explicitly, same as Studio.test.tsx.
    render(<IdentityProvider apiBase=""><Play apiBase="" /></IdentityProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remix" })).toBeTruthy());
    act(() => { screen.getByRole("button", { name: "Remix" }).click(); });
    await waitFor(() => expect(importCall).toHaveBeenCalledWith(expect.anything(), {
      body: expect.objectContaining({
        title: "snake-remix", html: "<html>x</html>", genre: "project-fun",
        remixOf: { gemKey: "@bob/snake", version: "1.2.0" },
      }),
    }));
  });

  it("a refused source (allowRemix off) surfaces the error and stays on the card", async () => {
    stubBoot();
    vi.spyOn(playRemixSourceRoute, "call").mockRejectedValue(new Error("the creator hasn't allowed remixing for this game"));
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Remix" })).toBeTruthy());
    act(() => { screen.getByRole("button", { name: "Remix" }).click(); });
    await waitFor(() => expect(screen.getByText(/hasn't allowed remixing/)).toBeTruthy());
  });

  it("cancel returns to the Arcade", async () => {
    stubBoot();
    window.location.hash = "#/play?remix=%40bob%2Fsnake";
    render(<Play apiBase="" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy());
    act(() => { screen.getByRole("button", { name: "Cancel" }).click(); });
    await waitFor(() => expect(screen.queryByText(/Remix .@bob\/snake./)).toBeNull());
    expect(screen.getByText("+ New miniapp")).toBeTruthy();
  });
});
