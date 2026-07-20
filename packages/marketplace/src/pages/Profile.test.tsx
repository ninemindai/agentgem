import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Profile } from "./Profile";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.pushState({}, "", "/"); });
const full = {
  login: "octocat", avatarUrl: "https://a/octocat", verified: true,
  githubUrl: "https://github.com/octocat", totalStars: 7,
  gems: [{ key: "@octocat/g", version: "1.0.0", description: "d", grade: 2, stars: 5, installs: 9, verifiedInstalls: 4 }],
  reviews: [],
};
const apiWith = (p: unknown) => ({ getProfile: () => Promise.resolve(p) }) as never;

describe("Profile page", () => {
  it("renders login, verified badge, avatar, total stars, and a gem card linking to the gem", async () => {
    render(<Profile api={apiWith(full)} login="octocat" base="" />);
    expect(await screen.findByRole("heading", { name: /octocat/ })).toBeTruthy();
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://a/octocat");
    const card = screen.getByText("@octocat/g").closest("a");
    expect(card?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("@octocat/g"));
  });

  it("renders the handle as a GitHub link only when githubUrl is set", async () => {
    render(<Profile api={apiWith(full)} login="octocat" base="" />);
    const link = await screen.findByRole("link", { name: "@octocat" });
    expect(link.getAttribute("href")).toBe("https://github.com/octocat");
  });

  it("a login-less (Google) profile shows the handle as plain text — NO GitHub link", async () => {
    render(<Profile api={apiWith({ ...full, login: "raymondg", githubUrl: null, verified: false })} login="raymondg" base="" />);
    expect(await screen.findByRole("heading", { name: /raymondg/ })).toBeTruthy();
    // the handle must NOT be a link (no misleading github.com/<handle>)
    expect(screen.queryByRole("link", { name: "@raymondg" })).toBeNull();
    expect(screen.queryByText(/verified/i)).toBeNull();
  });

  it("omits the verified badge and avatar when absent", async () => {
    render(<Profile api={apiWith({ ...full, verified: false, avatarUrl: null })} login="octocat" base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.queryByText(/verified/i)).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows an empty-gems note for a profile with no published gems", async () => {
    render(<Profile api={apiWith({ ...full, gems: [] })} login="octocat" base="" />);
    expect(await screen.findByText(/hasn't published/i)).toBeTruthy();
  });

  it("renders reviews under the Reviews tab, linking each to its /skill page", async () => {
    window.history.pushState({}, "", "/@octocat?tab=reviews");
    const withReviews = { ...full, reviews: [ { sourceId: "matt-skills", path: "productivity/brainstorming.md", name: "brainstorming", rating: 5, body: "a keeper", createdAt: "2026-07-02T00:00:00Z" } ] };
    render(<Profile api={apiWith(withReviews)} login="octocat" me={{ id:"1", name:"octocat", handle:"octocat", avatarUrl:null, orgs:[] }} base="" />);
    const link = await screen.findByText("brainstorming");
    expect(link.closest("a")?.getAttribute("href")).toBe("/skills/matt-skills/productivity/brainstorming.md");
  });

  it("shows a not-found state when the profile is null", async () => {
    render(<Profile api={apiWith(null)} login="ghost" base="" />);
    expect(await screen.findByText(/no profile for @ghost/i)).toBeTruthy();
  });

  it("a non-owner viewer sees only Apps and Reviews tabs", async () => {
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"2", name:"bob", handle:"bob", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.getByRole("tab", { name: "Apps" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Reviews" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Account" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Groups" })).toBeNull();
  });

  it("the owner sees all five tabs", async () => {
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"1", name:"octocat", handle:"octocat", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    for (const t of ["Apps","Reviews","Orgs","Groups","Account"]) expect(screen.getByRole("tab", { name: t })).toBeTruthy();
  });

  it("a non-owner requesting ?tab=account falls back to Apps (no account controls)", async () => {
    window.history.pushState({}, "", "/@octocat?tab=account");
    render(<Profile api={apiWith(full)} login="octocat" me={{ id:"2", name:"bob", handle:"bob", avatarUrl:null, orgs:[] }} base="" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.getByRole("tab", { name: "Apps" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: /^account$/i })).toBeNull();
  });

  // Regression: a linkSocial collision returns to the bare profile path with ?error= and NO
  // ?tab=account, so the owner must still land on the Account tab where the "Merge this account"
  // recovery lives — not stranded on the default Apps tab with a dangling error.
  it("routes an owner's linkSocial collision (?error=, no tab) to the Account tab so the merge recovery is reachable", async () => {
    window.history.pushState({}, "", "/@octocat?error=account_already_linked_to_different_user");
    // AccountPanel mounts PasskeysSection, which fetches — stub it so no real network call leaks.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })));
    const api = { getProfile: () => Promise.resolve(full), getAccountProviders: () => Promise.resolve({ connected: ["github"] }) } as never;
    render(<Profile api={api} login="octocat" me={{ id:"1", name:"octocat", handle:"octocat", avatarUrl:null, orgs:[] }} base="" />);
    const accountTab = await screen.findByRole("tab", { name: "Account" });
    expect(accountTab.getAttribute("aria-selected")).toBe("true");
    // AccountPanel's collision banner is rendered (the recovery entry point), not the Apps list.
    expect(await screen.findByText(/already linked to a different AgentGem account/i)).toBeTruthy();
  });
});

describe("Profile own-orgs navigation", () => {
  const profile = { login: "alice", avatarUrl: null, verified: true, githubUrl: "https://github.com/alice", totalStars: 0, gems: [], reviews: [] };
  const apiP = { getProfile: () => Promise.resolve(profile) } as never;
  const orgs = [{ scope: "ninemind", role: "admin" }, { scope: "acme", role: "member" }];

  it("shows the signed-in owner their orgs with role badges and Team Pulse links", async () => {
    window.history.pushState({}, "", "/@alice?tab=orgs");
    render(<Profile api={apiP} login="alice" me={{ id: "u1", name: "alice", handle: "alice", avatarUrl: null, orgs }} base="" />);
    expect(await screen.findByLabelText("your orgs")).toBeTruthy();
    expect(screen.getByText("@ninemind").getAttribute("href")).toBe("/orgs/ninemind");
    expect(screen.getByText("admin")).toBeTruthy(); // role badge on ninemind only
    const pulses = screen.getAllByText("Team Pulse →");
    expect(pulses.map((a) => a.getAttribute("href"))).toEqual(["/orgs/ninemind/usage", "/orgs/acme/usage"]);
  });

  it("the Orgs tab isn't offered to non-owners / signed-out", async () => {
    const { unmount } = render(<Profile api={apiP} login="alice" me={{ id: "u2", name: "bob", handle: "bob", avatarUrl: null, orgs }} base="" />);
    await screen.findByText("@alice");
    expect(screen.queryByRole("tab", { name: "Orgs" })).toBeNull();
    unmount();
    render(<Profile api={apiP} login="alice" me={null} base="" />);
    await screen.findByText("@alice");
    expect(screen.queryByRole("tab", { name: "Orgs" })).toBeNull();
  });
});
