import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Profile } from "./Profile";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const full = {
  login: "octocat", avatarUrl: "https://a/octocat", verified: true,
  githubUrl: "https://github.com/octocat", totalStars: 7,
  gems: [{ key: "@octocat/g", version: "1.0.0", description: "d", grade: 2, stars: 5, installs: 9, verifiedInstalls: 4 }],
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

  it("shows a not-found state when the profile is null", async () => {
    render(<Profile api={apiWith(null)} login="ghost" />);
    expect(await screen.findByText(/no profile for @ghost/i)).toBeTruthy();
  });
});
