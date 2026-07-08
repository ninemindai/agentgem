// packages/console/src/panels/Play/__tests__/PlayDeepLink.test.tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { Play } from "../index.js";
import { testbedProjectsRoute } from "../../../api/routes.js";

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
