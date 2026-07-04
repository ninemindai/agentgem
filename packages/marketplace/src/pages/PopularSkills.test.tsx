import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PopularSkills } from "./PopularSkills";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

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
    render(<PopularSkills api={makeApi("")} />);

    expect(await screen.findByText("The Agency")).toBeTruthy();
    expect(screen.getByText(/14\.4k/)).toBeTruthy();
    expect(screen.getByText("mattpocock/skills")).toBeTruthy();
    expect(screen.getByText(/355/)).toBeTruthy();

    expect(screen.getByText("ai-engineer")).toBeTruthy();
    expect(screen.getByText("Builds and ships AI features end to end.")).toBeTruthy();
    expect(screen.getByText("brainstorming")).toBeTruthy();

    const links = screen.getAllByText("View on GitHub →");
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toBe("https://github.com/o/agency-agents/blob/HEAD/engineering/ai-engineer.md");
    expect(links[0]!.getAttribute("target")).toBe("_blank");
    expect(links[0]!.getAttribute("rel")).toBe("noreferrer");
  });

  it("shows the empty state when the index hasn't run yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ groups: [] })));
    render(<PopularSkills api={makeApi("")} />);
    expect(await screen.findByText("No skills indexed yet.")).toBeTruthy();
  });
});
