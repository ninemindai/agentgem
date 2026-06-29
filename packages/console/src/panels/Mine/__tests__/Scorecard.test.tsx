import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { ScorecardHero, ScorecardHeroSkeleton } from "../Scorecard.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: ["wire up CI"], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/r/a", label: "alpha", breadth: 14, battleTested: 3, portable: 5, workflows: [] }],
};

describe("ScorecardHero", () => {
  it("renders the reusable workflow count in the heading", async () => {
    render(<ScorecardHero data={sc} />);
    expect(await screen.findByText(/14 reusable workflows/i)).toBeTruthy();
  });
  it("renders plain stat line with battle-tested and worth sharing counts", () => {
    render(<ScorecardHero data={sc} />);
    expect(screen.getByText(/3 battle-tested/i)).toBeTruthy();
    expect(screen.getByText(/5 worth sharing/i)).toBeTruthy();
  });
  it("never renders a dollar figure", () => {
    const { container } = render(<ScorecardHero data={sc} />);
    expect(container.textContent).not.toMatch(/\$/);
  });
  it("has no interactive filter chip buttons in the hero", () => {
    const { container } = render(<ScorecardHero data={sc} />);
    // Only the share button should be present — no chip toggles
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toMatch(/share your goldmine/i);
  });
});

describe("ScorecardHeroSkeleton", () => {
  it("shows a busy loading placeholder while scoring", () => {
    const { container } = render(<ScorecardHeroSkeleton />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
