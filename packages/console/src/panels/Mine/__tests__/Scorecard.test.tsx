import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { ScorecardHero, ScorecardHeroSkeleton } from "../Scorecard.js";
import type { Scorecard } from "../../../api/routes.js";

const sc: Scorecard = {
  breadth: 14, battleTested: 3, portable: 5, gaps: ["wire up CI"], generatedAtMs: 0, degraded: false,
  projects: [{ root: "/r/a", label: "alpha", breadth: 14, battleTested: 3, portable: 5, workflows: [] }],
};

describe("ScorecardHero", () => {
  it("renders the asset-framed counts", async () => {
    render(<ScorecardHero data={sc} filter="all" onFilter={vi.fn()} />);
    expect(await screen.findByText(/14 reusable workflows/i)).toBeTruthy();
    expect(screen.getByText(/3 battle-tested/i)).toBeTruthy();
    expect(screen.getByText(/5 worth sharing/i)).toBeTruthy();
  });
  it("never renders a dollar figure", () => {
    const { container } = render(<ScorecardHero data={sc} filter="all" onFilter={vi.fn()} />);
    expect(container.textContent).not.toMatch(/\$/);
  });
  it("clicking the battle-tested chip calls onFilter('battleTested')", () => {
    const onFilter = vi.fn();
    render(<ScorecardHero data={sc} filter="all" onFilter={onFilter} />);
    fireEvent.click(screen.getByText(/3 battle-tested/i));
    expect(onFilter).toHaveBeenCalledWith("battleTested");
  });
  it("clicking the active battle-tested chip calls onFilter('all')", () => {
    const onFilter = vi.fn();
    render(<ScorecardHero data={sc} filter="battleTested" onFilter={onFilter} />);
    fireEvent.click(screen.getByText(/3 battle-tested/i));
    expect(onFilter).toHaveBeenCalledWith("all");
  });
  it("the active chip has aria-pressed='true'", () => {
    render(<ScorecardHero data={sc} filter="portable" onFilter={vi.fn()} />);
    const portableBtn = screen.getByText(/5 worth sharing/i);
    expect(portableBtn.getAttribute("aria-pressed")).toBe("true");
    const btBtn = screen.getByText(/3 battle-tested/i);
    expect(btBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("ScorecardHeroSkeleton", () => {
  it("shows a busy loading placeholder while scoring", () => {
    const { container } = render(<ScorecardHeroSkeleton />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
