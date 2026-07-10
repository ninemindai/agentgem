import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Profile } from "./Profile";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const full = {
  login: "octocat", avatarUrl: "https://a/octocat", verified: true,
  githubUrl: "https://github.com/octocat", totalStars: 7,
  gems: [{ key: "@octocat/g", version: "1.0.0", description: "d", grade: 2, stars: 5, installs: 9, verifiedInstalls: 4 }],
  reviews: [],
};
const apiWith = (p: unknown) => ({ getProfile: () => Promise.resolve(p) }) as never;

describe("Profile page", () => {
  it("renders login, verified badge, avatar, total stars, and a gem card linking to the gem", async () => {
    render(<Profile api={apiWith(full)} login="octocat" />);
    expect(await screen.findByRole("heading", { name: /octocat/ })).toBeTruthy();
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("https://a/octocat");
    const card = screen.getByText("@octocat/g").closest("a");
    expect(card?.getAttribute("href")).toBe("/gems/" + encodeURIComponent("@octocat/g"));
  });

  it("renders the handle as a GitHub link only when githubUrl is set", async () => {
    render(<Profile api={apiWith(full)} login="octocat" />);
    const link = await screen.findByRole("link", { name: "@octocat" });
    expect(link.getAttribute("href")).toBe("https://github.com/octocat");
  });

  it("a login-less (Google) profile shows the handle as plain text — NO GitHub link", async () => {
    render(<Profile api={apiWith({ ...full, login: "raymondg", githubUrl: null, verified: false })} login="raymondg" />);
    expect(await screen.findByRole("heading", { name: /raymondg/ })).toBeTruthy();
    // the handle must NOT be a link (no misleading github.com/<handle>)
    expect(screen.queryByRole("link", { name: "@raymondg" })).toBeNull();
    expect(screen.queryByText(/verified/i)).toBeNull();
  });

  it("omits the verified badge and avatar when absent", async () => {
    render(<Profile api={apiWith({ ...full, verified: false, avatarUrl: null })} login="octocat" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.queryByText(/verified/i)).toBeNull();
    expect(document.querySelector("img")).toBeNull();
  });

  it("shows an empty-gems note for a profile with no published gems", async () => {
    render(<Profile api={apiWith({ ...full, gems: [] })} login="octocat" />);
    expect(await screen.findByText(/hasn't published/i)).toBeTruthy();
  });

  it("renders a 'Reviews written' section linking each review to its /skill page", async () => {
    const withReviews = { ...full, reviews: [
      { sourceId: "matt-skills", path: "productivity/brainstorming.md", name: "brainstorming", rating: 5, body: "a keeper", createdAt: "2026-07-02T00:00:00Z" },
    ] };
    render(<Profile api={apiWith(withReviews)} login="octocat" />);
    expect(await screen.findByText("Reviews written")).toBeTruthy();
    const link = screen.getByText("brainstorming").closest("a");
    expect(link?.getAttribute("href")).toBe("/skill/matt-skills/productivity/brainstorming.md");
    expect(screen.getByText("a keeper")).toBeTruthy();
  });

  it("omits the 'Reviews written' section when the user has written none", async () => {
    render(<Profile api={apiWith(full)} login="octocat" />);
    await screen.findByRole("heading", { name: /octocat/ });
    expect(screen.queryByText("Reviews written")).toBeNull();
  });

  it("shows a not-found state when the profile is null", async () => {
    render(<Profile api={apiWith(null)} login="ghost" />);
    expect(await screen.findByText(/no profile for @ghost/i)).toBeTruthy();
  });
});

describe("Profile own-orgs navigation", () => {
  const profile = { login: "alice", avatarUrl: null, verified: true, githubUrl: "https://github.com/alice", totalStars: 0, gems: [], reviews: [] };
  const apiP = { getProfile: () => Promise.resolve(profile) } as never;
  const orgs = [{ scope: "ninemind", role: "admin" }, { scope: "acme", role: "member" }];

  it("shows the signed-in owner their orgs with role badges and Team Pulse links", async () => {
    render(<Profile api={apiP} login="alice" me={{ id: "u1", name: "alice", handle: "alice", avatarUrl: null, orgs }} />);
    expect(await screen.findByLabelText("your orgs")).toBeTruthy();
    expect(screen.getByText("@ninemind").getAttribute("href")).toBe("/orgs/ninemind");
    expect(screen.getByText("admin")).toBeTruthy(); // role badge on ninemind only
    const pulses = screen.getAllByText("Team Pulse →");
    expect(pulses.map((a) => a.getAttribute("href"))).toEqual(["/orgs/ninemind/usage", "/orgs/acme/usage"]);
  });

  it("hides the section from other viewers and when signed out", async () => {
    const { unmount } = render(<Profile api={apiP} login="alice" me={{ id: "u2", name: "bob", handle: "bob", avatarUrl: null, orgs }} />);
    await screen.findByText("@alice");
    expect(screen.queryByLabelText("your orgs")).toBeNull();
    unmount();
    render(<Profile api={apiP} login="alice" me={null} />);
    await screen.findByText("@alice");
    expect(screen.queryByLabelText("your orgs")).toBeNull();
  });
});
