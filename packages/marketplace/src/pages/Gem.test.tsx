import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Gem } from "./Gem";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Static fallback path: empty live list → STATIC_GEMS (which include brainstorming-kit with ingredients).
const apiEmpty = { getGems: () => Promise.resolve([]), gemAdoption: () => Promise.resolve({}) } as never;
// Live path: one ingredient-less gem.
const apiLive = { getGems: () => Promise.resolve([{ key: "live-gem", version: "3.0.0", author: "acme", description: "d", tags: [], artifactKinds: ["mcp"] }]), gemAdoption: () => Promise.resolve({}) } as never;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Gem (detail)", () => {
  it("renders a fallback (static) gem with its Contains cross-links", async () => {
    render(<Gem api={apiEmpty} keyName="brainstorming-kit" stars={stars} me={null} />);
    expect(await screen.findByRole("heading", { name: /brainstorming-kit/ })).toBeTruthy();
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredient/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("renders a live (ingredient-less) gem with NO Contains section", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} />);
    expect(await screen.findByRole("heading", { name: /live-gem/ })).toBeTruthy();
    expect(screen.queryByText(/Contains/i)).toBeNull();
  });

  it("copy-key writes the key to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} />);
    await screen.findByRole("heading", { name: /live-gem/ });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("live-gem");
  });

  it("shows a not-found state for an unknown key", async () => {
    render(<Gem api={apiEmpty} keyName="does-not-exist" stars={stars} me={null} />);
    expect(await screen.findByText(/gem not found/i)).toBeTruthy();
  });

  it("renders a StarButton next to the gem title after load", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} />);
    await screen.findByRole("heading", { name: /live-gem/ });
    expect((await screen.findAllByRole("button", { name: /star/i })).length).toBeGreaterThan(0);
  });

  it("renders a linked @publishedBy byline to the profile", async () => {
    const apiPub = { getGems: () => Promise.resolve([{ key: "pub-gem", version: "1.0.0", publishedBy: "rfeng", author: "acme", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    render(<Gem api={apiPub} keyName="pub-gem" stars={stars} me={null} />);
    const link = (await screen.findByText("@rfeng")).closest("a");
    expect(link?.getAttribute("href")).toBe("/@rfeng");
  });

  it("falls back to unlinked 'by {author}' when there is no publishedBy", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} />); // apiLive gem: author 'acme', no publishedBy
    await screen.findByRole("heading", { name: /live-gem/ });
    expect(screen.getByText(/by acme/)).toBeTruthy();
    expect(screen.queryByText("@acme")).toBeNull(); // author is NOT linked
  });

  const apiOwned = { getGems: () => Promise.resolve([{ key: "owned-gem", version: "1.0.0", publishedBy: "rfeng", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;

  it("shows the owner-only Unpublish button when the signed-in login matches publishedBy (case-insensitive)", async () => {
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={{ login: "RFeng", avatarUrl: null, orgs: [] }} />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.getByRole("button", { name: /unpublish/i })).toBeTruthy();
  });

  it("hides the Unpublish button from a non-owner (and when signed out)", async () => {
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={{ login: "someone-else", avatarUrl: null, orgs: [] }} />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
    cleanup();
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={null} />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
  });
});
