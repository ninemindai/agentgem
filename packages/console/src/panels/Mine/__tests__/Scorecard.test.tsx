import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
    // Only the share button — no chip toggles, no download
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toMatch(/share my goldmine/i);
  });
  it("does not render the certificate image", () => {
    const { container } = render(<ScorecardHero data={sc} />);
    expect(container.querySelector("img.scorecard-card")).toBeNull();
    expect(screen.queryByAltText(/goldmine certificate/i)).toBeNull();
  });
  it("does not render a download button", () => {
    render(<ScorecardHero data={sc} />);
    expect(screen.queryByText(/download png/i)).toBeNull();
  });
});

const data = { breadth: 14, battleTested: 3, portable: 5, gaps: [], projects: [], generatedAtMs: 7, degraded: false } as never;

describe("ScorecardHero share", () => {
  it("mints a hosted url and shows share intents", async () => {
    const createShare = vi.fn(async () => ({ id: "abc", url: "https://agentgem.ai/share/abc" }));
    render(<ScorecardHero data={data} createShare={createShare} />);
    fireEvent.click(screen.getByText(/share my goldmine/i));
    await waitFor(() => expect(createShare).toHaveBeenCalledWith({ kind: "certificate", counts: { breadth: 14, battleTested: 3, portable: 5 }, generatedAtMs: 7 }));
    const link = await screen.findByRole("link", { name: "X" });
    expect(link.getAttribute("href")).toContain(encodeURIComponent("https://agentgem.ai/share/abc"));
  });
});

describe("ScorecardHeroSkeleton", () => {
  it("shows a busy loading placeholder while scoring", () => {
    const { container } = render(<ScorecardHeroSkeleton />);
    expect(screen.getByText(/scoring your goldmine/i)).toBeTruthy();
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
  });
});
