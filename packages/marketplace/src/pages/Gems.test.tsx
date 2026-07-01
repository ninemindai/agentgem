import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Gems } from "./Gems";
import { STATIC_GEMS } from "../gems/catalog";

afterEach(() => cleanup());
const apiWith = (impl: () => Promise<unknown>) => ({ getGems: impl, gemAdoption: () => Promise.resolve({}) }) as never;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Gems (browse)", () => {
  it("renders live gems from the api", async () => {
    const api = apiWith(() => Promise.resolve([{ key: "live-gem", version: "3.0.0", description: "d", tags: [], artifactKinds: ["mcp"] }]));
    render(<Gems api={api} stars={stars} />);
    expect(await screen.findByText("live-gem")).toBeTruthy();
  });

  it("falls back to the static catalog when the api returns empty", async () => {
    const api = apiWith(() => Promise.resolve([]));
    render(<Gems api={api} stars={stars} />);
    expect(await screen.findByText(STATIC_GEMS[0].key)).toBeTruthy();
  });

  it("search narrows the loaded list", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback (has github-flow + brainstorming-kit)
    render(<Gems api={api} stars={stars} />);
    await screen.findByText("brainstorming-kit");
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "github" } });
    expect(screen.getByText("github-flow")).toBeTruthy();
    expect(screen.queryByText("brainstorming-kit")).toBeNull();
  });

  it("shows a no-match state when nothing matches the search", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback
    render(<Gems api={api} stars={stars} />);
    await screen.findByText("brainstorming-kit");
    fireEvent.change(screen.getByLabelText("search gems"), { target: { value: "zzzznomatch" } });
    expect(screen.getByText(/no gems match/i)).toBeTruthy();
  });

  it("renders a StarButton for each gem after load", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback
    render(<Gems api={api} stars={stars} />);
    await screen.findByText("brainstorming-kit");
    expect((await screen.findAllByRole("button", { name: /star/i })).length).toBeGreaterThan(0);
  });

  it("reflects server counts + the caller's stars from GET /api/stars", async () => {
    const api = apiWith(() => Promise.resolve([]));  // → static fallback
    const starred = { ...stars, signedIn: true, api: { get: async () => ({ counts: { "brainstorming-kit": 7 }, mine: ["brainstorming-kit"] }), toggle: async () => ({ starred: true, count: 7 }) } as never };
    render(<Gems api={api} stars={starred} />);
    await screen.findByText("brainstorming-kit");
    await waitFor(() => {
      const starOn = screen.getAllByRole("button", { name: /unstar/i });
      expect(starOn.length).toBe(1);
      expect(starOn[0].textContent).toContain("7");
    });
  });

  it("renders a cut badge for a typed gem and filters by cut", async () => {
    const api = apiWith(() => Promise.resolve([
      { key: "intgem", version: "1.0.0", description: "d", tags: [], artifactKinds: ["mcp_server"], type: "integration" },
      { key: "guidegem", version: "1.0.0", description: "d", tags: [], artifactKinds: ["instructions"], type: "guide" },
    ]));
    render(<Gems api={api} stars={stars} />);
    expect((await screen.findAllByText("Integration")).length).toBeGreaterThan(0); // the cut pill label
    // facet chip narrows to the integration gem
    fireEvent.click(screen.getByRole("button", { name: /filter by Integration/i }));
    await waitFor(() => expect(screen.queryByText("guidegem")).toBeNull());
    expect(screen.getByText("intgem")).toBeTruthy();
  });
});
