import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PopularSkills } from "./PopularSkills";
import { makeApi } from "../api";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const res = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as unknown as Response;

const skills = [
  { sourceId: "agency-agents", source: "The Agency", division: "engineering", name: "ai-engineer", path: "engineering/ai-engineer.md", repo: "o/agency-agents", homepage: "https://github.com/o/agency-agents", stars: 14400, installs: null },
  { sourceId: "matt-skills", source: "mattpocock/skills", division: "productivity", name: "brainstorming", path: "productivity/brainstorming.md", repo: "mattpocock/skills", homepage: null, stars: 355, installs: 12 },
];

describe("PopularSkills", () => {
  it("renders skills in ranked order with a star/install count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ skills })));
    render(<PopularSkills api={makeApi("")} />);
    const names = (await screen.findAllByText(/ai-engineer|brainstorming/)).map((n) => n.textContent);
    expect(names).toEqual(["ai-engineer", "brainstorming"]);
    expect(screen.getByText(/14\.4k/)).toBeTruthy();
    expect(screen.getByText(/12 installs/)).toBeTruthy();
  });

  it("shows the empty state when the index hasn't run yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({ skills: [] })));
    render(<PopularSkills api={makeApi("")} />);
    expect(await screen.findByText("No skills indexed yet.")).toBeTruthy();
  });
});
