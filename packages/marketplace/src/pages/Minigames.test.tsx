// packages/marketplace/src/pages/Minigames.test.tsx
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { Minigames } from "./Minigames";
import { makeApi } from "../api";

const res = (body: unknown) => ({ ok: true, text: async () => JSON.stringify(body) });
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const twoGems = [
  { key: "@me/duel", version: "1.0.0", artifactKinds: ["game"], description: "a coding duel" },
  { key: "@me/kit", version: "1.0.0", artifactKinds: ["skill"], description: "a skill kit" },
];
const stubFetch = (gems: unknown[]) => vi.stubGlobal("fetch", vi.fn(async (url: string) => {
  if (url.includes("/api/registry/gems")) return res({ gems });
  if (url.includes("/api/aggregator/game-html")) return res({ html: "<h1>PLAY ME</h1>" });
  return res({});
}) as unknown as typeof fetch);

describe("Minigames", () => {
  it("lists only game gems and plays each game's sealed html inline", async () => {
    stubFetch(twoGems);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    expect(screen.queryByText("@me/kit")).toBeNull(); // non-game filtered out
    await waitFor(() => {
      const f = document.querySelector('iframe[title="mini-game"]') as HTMLIFrameElement | null;
      expect(f?.getAttribute("srcdoc")).toContain("PLAY ME"); // sealed + played
      expect(f?.getAttribute("sandbox")).toBe("allow-scripts"); // null-origin seal
    });
  });

  it("says it is loading miniapps before the gem list arrives", () => {
    stubFetch([]);
    render(<Minigames api={makeApi("")} stars={stars} />);
    expect(screen.getByText("Loading miniapps…")).toBeTruthy(); // before any await: gems is still null
  });

  it("shows an empty state when no games are published", async () => {
    stubFetch([{ key: "@me/kit", version: "1.0.0", artifactKinds: ["skill"], description: "kit" }]);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText(/No miniapps published yet/i)).toBeTruthy());
  });

  // "Make your own" must land the reader in a Composer already seeded from THIS game — the whole
  // point of putting the link on each card rather than once on the page.
  it("gives each game a deep link that opens Play prefilled to build your own version", async () => {
    stubFetch(twoGems);
    render(<Minigames api={makeApi("")} stars={stars} />);
    const link = await screen.findByRole("link", { name: "Make your own" });
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("agentgem://play?")).toBe(true);
    const q = new URLSearchParams(href.split("?")[1]);
    expect(q.get("new")).toBe("1");
    expect(q.get("title")).toBe("duel-remix");            // scope stripped from @me/duel
    expect(q.get("prompt")).toContain("@me/duel");         // seeded from this game, not a generic prompt
    expect(q.get("prompt")).toContain("a coding duel");
  });

  it("puts a Download-for-offline-play control on each game card", async () => {
    stubFetch(twoGems);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await screen.findByText("@me/duel");
    // one toggle per rendered game card (twoGems has a single "game"; @me/kit is a skill, filtered out)
    const cards = document.querySelectorAll(".mg-card");
    expect(screen.getAllByRole("button", { name: /download for offline play/i })).toHaveLength(cards.length);
  });

  it("stars a game under the same ('gem', key) identity the Gems pages use", async () => {
    stubFetch(twoGems);
    const get = vi.fn(async () => ({ counts: { "@me/duel": 4 }, mine: ["@me/duel"] }));
    const starred = { ...stars, signedIn: true, api: { get, toggle: async () => ({ starred: true, count: 4 }) } as never };
    render(<Minigames api={makeApi("")} stars={starred} />);
    await waitFor(() => expect(screen.getByText("4")).toBeTruthy());       // server count rendered
    expect(get).toHaveBeenCalledWith("gem", ["@me/duel"]);                  // games-only, kind "gem"
    expect(screen.getByRole("button", { name: "Unstar" })).toBeTruthy();    // "mine" reflected
  });

  const tagged = [
    { key: "@me/duel", version: "1.0.0", artifactKinds: ["game"], description: "a coding duel", tags: ["game", "replay", "puzzle"] },
    { key: "@me/heat", version: "1.0.0", artifactKinds: ["game"], description: "a heatmap view", tags: ["game", "session-heatmap"] },
  ];

  it("filters the grid by the search box", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("search miniapps"), { target: { value: "heatmap" } });
    expect(screen.queryByText("@me/duel")).toBeNull();
    expect(screen.getByText("@me/heat")).toBeTruthy();
  });

  it("filters by a genre chip", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filter by Session replay/i }));
    await waitFor(() => expect(screen.queryByText("@me/heat")).toBeNull());
    expect(screen.getByText("@me/duel")).toBeTruthy();
  });

  it("clicking a tag chip narrows to matching miniapps", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /filter by tag puzzle/i }));
    await waitFor(() => expect(screen.queryByText("@me/heat")).toBeNull());
    expect(screen.getByText("@me/duel")).toBeTruthy();
  });

  it("shows a no-match state when the search matches nothing", async () => {
    stubFetch(tagged);
    render(<Minigames api={makeApi("")} stars={stars} />);
    await waitFor(() => expect(screen.getByText("@me/duel")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("search miniapps"), { target: { value: "zzzznope" } });
    expect(screen.getByText(/no miniapps match/i)).toBeTruthy();
  });
});
