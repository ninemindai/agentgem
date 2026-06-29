import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScorecardHero, ScorecardHeroSkeleton } from "../Scorecard.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: ["wire up CI"], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/r/a", label: "alpha", breadth: 14, battleTested: 3, portable: 5, workflows: [] }],
};

describe("ScorecardHero", () => {
  it("renders the asset-framed counts", async () => {
    render(<ScorecardHero data={sc} onDistill={vi.fn()} />);
    expect(await screen.findByText(/14 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/3 battle-tested/i)).toBeTruthy();
    expect(screen.getByText(/5 worth sharing/i)).toBeTruthy();
  });
  it("never renders a dollar figure", () => {
    const { container } = render(<ScorecardHero data={sc} onDistill={vi.fn()} />);
    expect(container.textContent).not.toMatch(/\$/);
  });
});

describe("ScorecardHeroSkeleton", () => {
  it("shows a busy loading placeholder while scoring", () => {
    const { container } = render(<ScorecardHeroSkeleton />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
