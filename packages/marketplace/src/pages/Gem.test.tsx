import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gem } from "./Gem";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Static fallback path: empty live list → STATIC_GEMS (which include brainstorming-kit with ingredients).
const apiEmpty = { getGems: () => Promise.resolve([]) } as never;
// Live path: one ingredient-less gem.
const apiLive = { getGems: () => Promise.resolve([{ key: "live-gem", version: "3.0.0", author: "acme", description: "d", tags: [], artifactKinds: ["mcp"] }]) } as never;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Gem (detail)", () => {
  it("renders a fallback (static) gem with its Contains cross-links", async () => {
    render(<Gem api={apiEmpty} keyName="brainstorming-kit" stars={stars} />);
    expect(await screen.findByRole("heading", { name: /brainstorming-kit/ })).toBeTruthy();
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("renders a live (ingredient-less) gem with NO Contains section", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} />);
    expect(await screen.findByRole("heading", { name: /live-gem/ })).toBeTruthy();
    expect(screen.queryByText(/Contains/i)).toBeNull();
  });

  it("copy-key writes the key to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} />);
    await screen.findByRole("heading", { name: /live-gem/ });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("live-gem");
  });

  it("shows a not-found state for an unknown key", async () => {
    render(<Gem api={apiEmpty} keyName="does-not-exist" stars={stars} />);
    expect(await screen.findByText(/gem not found/i)).toBeTruthy();
  });

  it("renders a StarButton next to the gem title after load", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} />);
    await screen.findByRole("heading", { name: /live-gem/ });
    expect((await screen.findAllByRole("button", { name: /star/i })).length).toBeGreaterThan(0);
  });
});
