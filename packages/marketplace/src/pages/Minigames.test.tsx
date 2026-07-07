// packages/marketplace/src/pages/Minigames.test.tsx
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Minigames } from "./Minigames";
import { makeApi } from "../api";

const res = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body) });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Minigames", () => {
  it("lists only game gems and plays each game's sealed html inline", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/api/registry/gems")) return res({ gems: [
        { key: "@me/duel", version: "1.0.0", artifactKinds: ["game"], description: "a coding duel" },
        { key: "@me/kit", version: "1.0.0", artifactKinds: ["skill"], description: "a skill kit" },
      ] });
      if (url.includes("/api/aggregator/game-html")) return res({ html: "<h1>PLAY ME</h1>" });
      return res({});
    }) as unknown as typeof fetch);
    render(<Minigames api={makeApi("")} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    expect(screen.queryByText("@me/kit")).toBeNull(); // non-game filtered out
    await waitFor(() => {
      const f = document.querySelector('iframe[title="mini-game"]') as HTMLIFrameElement | null;
      expect(f?.getAttribute("srcdoc")).toContain("PLAY ME"); // sealed + played
      expect(f?.getAttribute("sandbox")).toBe("allow-scripts"); // null-origin seal
    });
  });

  it("shows an empty state when no games are published", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/api/registry/gems")
        ? res({ gems: [{ key: "@me/kit", version: "1.0.0", artifactKinds: ["skill"], description: "kit" }] })
        : res({})) as unknown as typeof fetch);
    render(<Minigames api={makeApi("")} />);
    await waitFor(() => expect(screen.getByText(/No mini-games published yet/i)).toBeTruthy());
  });
});
