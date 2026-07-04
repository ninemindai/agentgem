import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { CatalogSkill } from "./CatalogSkill";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
// import endpoint feeds the inline SKILL.md preview
const importFetch = () => vi.stubGlobal("fetch", vi.fn(async () => res({ name: "brainstorming", content: "the body" })));

const reviewsCtx = (over: any = {}) => ({
  signedIn: false, loginUrl: () => "/login",
  api: {
    getSummaries: async () => ({}),
    get: async () => ({ summary: { avg: 0, count: 0 }, reviews: [], mine: null }),
    submit: async () => ({ mine: { rating: 5, body: "x", createdAt: "", updatedAt: "" }, summary: { avg: 5, count: 1 } }),
    remove: async () => ({ summary: { avg: 0, count: 0 } }),
    ...over,
  },
}) as never;

const P = { api: makeApi(""), sourceId: "matt-skills", path: "productivity/brainstorming.md" };

describe("CatalogSkill", () => {
  it("puts Reviews before SKILL.md and shows the first-reviewer empty state", async () => {
    importFetch();
    render(<CatalogSkill {...P} reviews={reviewsCtx()} />);
    await screen.findByText(/be the first to review/);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(headings.indexOf("Reviews")).toBeLessThan(headings.indexOf("SKILL.md"));
  });

  it("signed-out shows the sign-in prompt, not the form", async () => {
    importFetch();
    render(<CatalogSkill {...P} reviews={reviewsCtx()} />);
    expect(await screen.findByText("Sign in to review")).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("renders the summary + review list when reviews exist", async () => {
    importFetch();
    const withReviews = reviewsCtx({
      get: async () => ({
        summary: { avg: 4.5, count: 2 },
        reviews: [
          { login: "bob", avatarUrl: null, rating: 5, body: "great", createdAt: "2026-07-02T00:00:00Z", updatedAt: "2026-07-02T00:00:00Z" },
          { login: "amy", avatarUrl: null, rating: 4, body: null, createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-01T00:00:00Z" },
        ],
        mine: null,
      }),
    });
    render(<CatalogSkill {...P} reviews={withReviews} />);
    expect(await screen.findByText("★ 4.5 · 2")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getByText("great")).toBeTruthy();
    expect(screen.getByText("amy")).toBeTruthy();
  });

  it("signed-in shows the write form and posts a review", async () => {
    importFetch();
    const submit = vi.fn(async () => ({ mine: { rating: 5, body: "nice", createdAt: "", updatedAt: "" }, summary: { avg: 5, count: 1 } }));
    const ctx = { signedIn: true, loginUrl: () => "/login", api: {
      getSummaries: async () => ({}),
      get: async () => ({ summary: { avg: 0, count: 0 }, reviews: [], mine: null }),
      submit, remove: async () => ({ summary: { avg: 0, count: 0 } }),
    } } as never;
    render(<CatalogSkill {...P} reviews={ctx} />);
    const picker = await screen.findByRole("radiogroup", { name: "Your rating" });
    fireEvent.click(screen.getAllByRole("radio")[4]!); // 5 stars
    fireEvent.change(screen.getByLabelText("Your review"), { target: { value: "nice" } });
    fireEvent.click(screen.getByText("Post review"));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("skill", "matt-skills/productivity/brainstorming.md", 5, "nice"));
    expect(picker).toBeTruthy();
  });
});
