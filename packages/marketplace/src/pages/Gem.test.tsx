import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { Gem } from "./Gem";

function stubFetch(routes: Record<string, (init?: RequestInit) => { status?: number; body?: unknown }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, "http://x").pathname;
    const h = routes[path] ?? (() => ({ body: {} }));
    const { status = 200, body = {} } = h(init);
    return { ok: status < 300, status, json: async () => body } as unknown as Response;
  }));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Static fallback path: empty live list → STATIC_GEMS (which include brainstorming-kit with ingredients).
const apiEmpty = { getGems: () => Promise.resolve([]), gemAdoption: () => Promise.resolve({}) } as never;
// Live path: one ingredient-less gem.
const apiLive = { getGems: () => Promise.resolve([{ key: "live-gem", version: "3.0.0", author: "acme", description: "d", tags: [], artifactKinds: ["mcp"] }]), gemAdoption: () => Promise.resolve({}) } as never;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };

describe("Gem (detail)", () => {
  it("renders a fallback (static) gem with its Contains cross-links", async () => {
    render(<Gem api={apiEmpty} keyName="brainstorming-kit" stars={stars} me={null} base="" />);
    expect(await screen.findByRole("heading", { name: /brainstorming-kit/ })).toBeTruthy();
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/ingredients/" + encodeURIComponent("skill:superpowers/brainstorming"));
  });

  it("renders a live (ingredient-less) gem with NO Contains section", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} base="" />);
    expect(await screen.findByRole("heading", { name: /live-gem/ })).toBeTruthy();
    expect(screen.queryByText(/Contains/i)).toBeNull();
  });

  it("shows created and updated dates when the gem carries timestamps", async () => {
    const api = { getGems: () => Promise.resolve([{ key: "dated-gem", version: "1.0.0", description: "d", tags: [], artifactKinds: ["mcp"], createdAtMs: Date.UTC(2026, 0, 5), updatedAtMs: Date.UTC(2026, 0, 20) }]), gemAdoption: () => Promise.resolve({}) } as never;
    const { container } = render(<Gem api={api} keyName="dated-gem" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /dated-gem/ });
    const dates = container.querySelector(".ex-gem-dates");
    expect(dates?.textContent).toMatch(/Created/);
    expect(dates?.textContent).toMatch(/Updated/);
  });

  it("copy-key writes the key to the clipboard", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /live-gem/ });
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith("live-gem");
  });

  it("shows a not-found state for an unknown key", async () => {
    render(<Gem api={apiEmpty} keyName="does-not-exist" stars={stars} me={null} base="" />);
    expect(await screen.findByText(/gem not found/i)).toBeTruthy();
  });

  it("renders a StarButton next to the gem title after load", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /live-gem/ });
    expect((await screen.findAllByRole("button", { name: /star/i })).length).toBeGreaterThan(0);
  });

  it("renders a linked @publishedBy byline to the profile", async () => {
    const apiPub = { getGems: () => Promise.resolve([{ key: "pub-gem", version: "1.0.0", publishedBy: "rfeng", author: "acme", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    render(<Gem api={apiPub} keyName="pub-gem" stars={stars} me={null} base="" />);
    const link = (await screen.findByText("@rfeng")).closest("a");
    expect(link?.getAttribute("href")).toBe("/@rfeng");
  });

  it("falls back to unlinked 'by {author}' when there is no publishedBy", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} base="" />); // apiLive gem: author 'acme', no publishedBy
    await screen.findByRole("heading", { name: /live-gem/ });
    expect(screen.getByText(/by acme/)).toBeTruthy();
    expect(screen.queryByText("@acme")).toBeNull(); // author is NOT linked
  });

  it("shows the one-liner install command for an installable gem", async () => {
    const apiInst = { getGems: () => Promise.resolve([{ key: "raymondfeng/agentgem-biz", version: "0.1.0", installable: true, description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    render(<Gem api={apiInst} keyName="raymondfeng/agentgem-biz" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /raymondfeng\/agentgem-biz/ });
    expect(screen.getByText("npx @ninemind/agentgem get raymondfeng/agentgem-biz@0.1.0")).toBeTruthy();
  });

  it("offers a Download .gem button for an installable gem", async () => {
    const apiInst = { getGems: () => Promise.resolve([{ key: "raymondfeng/agentgem-biz", version: "0.1.0", installable: true, description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    render(<Gem api={apiInst} keyName="raymondfeng/agentgem-biz" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /raymondfeng\/agentgem-biz/ });
    expect(screen.getByRole("button", { name: /download \.gem/i })).toBeTruthy();
  });

  it("omits the install command for a browse-only (non-installable) gem", async () => {
    render(<Gem api={apiLive} keyName="live-gem" stars={stars} me={null} base="" />); // apiLive gem has no installable flag
    await screen.findByRole("heading", { name: /live-gem/ });
    expect(screen.queryByText(/npx @ninemind\/agentgem get/)).toBeNull();
  });

  const apiOwned = { getGems: () => Promise.resolve([{ key: "owned-gem", version: "1.0.0", publishedBy: "rfeng", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;

  it("shows the owner-only Unpublish button when the signed-in handle matches publishedBy (case-insensitive)", async () => {
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={{ id: "u1", name: "RFeng", handle: "RFeng", avatarUrl: null, orgs: [] }} base="" />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.getByRole("button", { name: /unpublish/i })).toBeTruthy();
  });

  it("hides the Unpublish button from a non-owner (and when signed out)", async () => {
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={{ id: "u2", name: "someone-else", handle: "someone-else", avatarUrl: null, orgs: [] }} base="" />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
    cleanup();
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={null} base="" />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
  });

  it("hides the Unpublish button from a signed-in user with no handle", async () => {
    render(<Gem api={apiOwned} keyName="owned-gem" stars={stars} me={{ id: "u3", name: "Ray", handle: null, avatarUrl: null, orgs: [] }} base="" />);
    await screen.findByRole("heading", { name: /owned-gem/ });
    expect(screen.queryByRole("button", { name: /unpublish/i })).toBeNull();
  });

  it("owner sees a share-with-group checkbox and can toggle it", async () => {
    const apiOwner = { getGems: () => Promise.resolve([{ key: "alice/app", version: "1.0.0", publishedBy: "alice", description: "d", tags: [], artifactKinds: ["skill"] }]), gemAdoption: () => Promise.resolve({}) } as never;
    let sharedPost: unknown = null;
    stubFetch({
      "/api/catalog/groups": () => ({ body: { groups: [{ id: "g1", name: "Team", role: "admin", kind: "native", installationId: null, scope: null }] } }),
      "/api/catalog/gem-shares": (init) => {
        if (init?.method === "POST") { sharedPost = JSON.parse(init.body as string); return { body: { shared: true } }; }
        return { body: { shares: [] } };
      },
    });
    render(<Gem api={apiOwner} keyName="alice/app" stars={stars} me={{ id: "1", name: "Alice", handle: "alice", avatarUrl: null, orgs: [] }} base="http://x" />);
    const checkbox = await screen.findByLabelText(/share with Team/i);
    fireEvent.click(checkbox);
    await waitFor(() => expect(sharedPost).toEqual({ key: "alice/app", groupId: "g1" }));
  });
});
