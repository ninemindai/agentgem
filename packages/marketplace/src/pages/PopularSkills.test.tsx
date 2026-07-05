import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PopularSkills } from "./PopularSkills";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;
const stars = { signedIn: false, loginUrl: () => "/login", api: { get: async () => ({ counts: {}, mine: [] }), toggle: async () => ({ starred: false, count: 0 }) } as never };
const emptyReviews = { signedIn: false, loginUrl: () => "/login", api: { getSummaries: async () => ({}), get: async () => ({ summary: { avg: 0, count: 0 }, reviews: [], mine: null }), submit: async () => ({}), remove: async () => ({}) } as never };
const reviews = emptyReviews;

const groups = [
  {
    sourceId: "agency-agents", source: "The Agency", repo: "o/agency-agents", homepage: "https://github.com/o/agency-agents", stars: 14400,
    skills: [
      { name: "ai-engineer", path: "engineering/ai-engineer.md", division: "engineering", description: "Builds and ships AI features end to end.", installs: null },
    ],
  },
  {
    sourceId: "matt-skills", source: "mattpocock/skills", repo: "mattpocock/skills", homepage: null, stars: 355,
    skills: [
      { name: "brainstorming", path: "productivity/brainstorming.md", division: "productivity", description: null, installs: 12 },
    ],
  },
];

describe("PopularSkills", () => {
  it("renders each group's header (source + stars) and its skill cards (name, description, GitHub link)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);

    expect(await screen.findByText("The Agency")).toBeTruthy();
    expect(screen.getByText(/14\.4k/)).toBeTruthy();
    expect(screen.getByText("mattpocock/skills")).toBeTruthy();
    expect(screen.getByText(/355/)).toBeTruthy();

    expect(screen.getByText("ai-engineer")).toBeTruthy();
    expect(screen.getByText("Builds and ships AI features end to end.")).toBeTruthy();
    expect(screen.getByText("brainstorming")).toBeTruthy();

    const links = screen.getAllByRole("link", { name: "View on GitHub" });
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe("https://github.com/o/agency-agents/blob/HEAD/engineering/ai-engineer.md");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noreferrer");
  });

  it("renders a Reviews action linking each card to its /skill/… page", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    await screen.findByText("ai-engineer");
    const reviewLinks = screen.getAllByRole("link", { name: "Reviews" });
    expect(reviewLinks).toHaveLength(2);
    expect(reviewLinks[0]!.getAttribute("href")).toBe("/skill/agency-agents/engineering/ai-engineer.md");
    expect(reviewLinks[1]!.getAttribute("href")).toBe("/skill/matt-skills/productivity/brainstorming.md");
  });

  it("renders a per-card author byline linking to the repo owner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    const author = await screen.findByText("by mattpocock");
    expect(author.getAttribute("href")).toBe("https://github.com/mattpocock");
    expect(screen.getByText("by o")).toBeTruthy();
  });

  it("renders a StarButton on each card after load", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    await screen.findByText("ai-engineer");
    expect((await screen.findAllByRole("button", { name: /star/i }))).toHaveLength(2);
  });

  it("filters cards by the search box (name / author / tag)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    await screen.findByText("ai-engineer");

    fireEvent.change(screen.getByLabelText("search skills"), { target: { value: "brainstorm" } });
    expect(screen.queryByText("ai-engineer")).toBeNull();
    expect(screen.getByText("brainstorming")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("search skills"), { target: { value: "engineering" } });
    expect(screen.getByText("ai-engineer")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
  });

  it("shows a no-match empty state when nothing matches the query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    await screen.findByText("ai-engineer");
    fireEvent.change(screen.getByLabelText("search skills"), { target: { value: "zzzznotreal" } });
    expect(screen.getByText(/No skills match/)).toBeTruthy();
    expect(screen.queryByText("ai-engineer")).toBeNull();
  });

  it("opens a Preview modal and shows the fetched SKILL.md", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/api/sources/import")
        ? res({ name: "brainstorming", content: "---\nname: brainstorming\n---\nUse when..." })
        : res({ groups }),
    ));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    const previewBtns = await screen.findAllByRole("button", { name: "Preview" });
    fireEvent.click(previewBtns[0]!);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByLabelText("SKILL.md")).toBeTruthy();
    expect(screen.getByText(/Use when/)).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the review aggregate only when count>0, and links the card title to /skill/…", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups })));
    const withSummary = { ...emptyReviews, api: { ...(emptyReviews as any).api,
      getSummaries: async () => ({ "matt-skills/productivity/brainstorming.md": { avg: 4.6, count: 12 } }) } } as never;
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={withSummary} />);
    // brainstorming card has a summary; ai-engineer does not → only one aggregate on the board
    const chip = await screen.findByText("★ 4.6 · 12");
    expect(screen.getAllByText(/★ \d/).filter((el) => /·/.test(el.textContent ?? ""))).toHaveLength(1);
    // the aggregate chip links to the skill page, same as the title
    expect(chip.getAttribute("href")).toBe("/skill/matt-skills/productivity/brainstorming.md");
    const title = screen.getByText("brainstorming");
    expect(title.getAttribute("href")).toBe("/skill/matt-skills/productivity/brainstorming.md");
  });

  it("shows the empty state when the index hasn't run yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups: [] })));
    render(<PopularSkills api={makeApi("")} stars={stars} reviews={reviews} />);
    expect(await screen.findByText("No skills indexed yet.")).toBeTruthy();
  });
});
