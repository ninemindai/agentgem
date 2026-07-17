import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent, act } from "@testing-library/react";
import * as routes from "../../api/routes.js";
import { Reveal } from "./Reveal.js";
import type { ScorecardStreamEvent } from "../Mine/scorecardStream.js";
import type { Scorecard } from "../../api/routes.js";

// This file asserts WHAT renders (branches/copy), not the count-up animation
// itself (covered by useCountUp.test.tsx) — force prefers-reduced-motion so
// every figure lands on its final value in the same tick the scorecard
// arrives, instead of racing a real ~900ms rAF animation against real-timer
// `findByText` polling.
beforeEach(() => { vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const SUMMARY: routes.HomeSummary = {
  usage: { sessions: 412, spanDays: 148, activeMs: 63 * 3_600_000, tokensIn: 200_000_000, tokensOut: 91_000_000, tokensCache: 0 },
  claudeSessions: 412,
  gate: { usageEmpty: false, claudeBelowGate: false },
  scorecardCached: false,
  projectsScanned: 5,
  projectsCap: 8,
};

const COLD_SUMMARY: routes.HomeSummary = {
  ...SUMMARY,
  usage: { sessions: 2, spanDays: 1, activeMs: 0, tokensIn: 0, tokensOut: 0, tokensCache: 0 },
  gate: { usageEmpty: true, claudeBelowGate: true },
};

const CODEX_HEAVY_SUMMARY: routes.HomeSummary = {
  ...SUMMARY,
  gate: { usageEmpty: false, claudeBelowGate: true },
};

const SCORECARD: Scorecard = {
  breadth: 17, battleTested: 6, portable: 4,
  gaps: ["no testing workflow yet", "deploy steps never captured", "no rollback plan"],
  projects: [{
    root: "/p", label: "p",
    breadth: 17, battleTested: 6, portable: 4,
    workflows: [
      { key: "a", name: "Ship a feature branch", confidence: "high", portable: true, sessions: 12, lastSeenMs: 10 },
      { key: "b", name: "Older workflow", confidence: "high", portable: false, sessions: 3, lastSeenMs: 1 },
    ],
  }],
  generatedAtMs: 1000, degraded: false,
};

function doneStream(scorecard: Scorecard) {
  return vi.fn((_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
    onEvent({ type: "done", scorecard, cached: false, updatedAt: 1 });
    return () => {};
  });
}

describe("Reveal — first-run pre-consent", () => {
  it("renders masthead + the consent sentence + the Scan button ONLY, with zero fetches", () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call");
    const openStream = vi.fn(() => () => {});
    render(<Reveal apiBase="" mode="first-run" onDismiss={() => {}} openStream={openStream} />);

    expect(screen.getByText(/AgentGem reads your local session history/)).toBeTruthy();
    expect(screen.getByText(
      "AgentGem reads your local session history — locally; nothing leaves this machine — to find what you've built.",
    )).toBeTruthy();
    expect(screen.getByRole("button", { name: "Scan my sessions" })).toBeTruthy();
    expect(screen.queryByText(/goldmine/i)).toBeNull();
    expect(summarySpy).not.toHaveBeenCalled();
    expect(openStream).not.toHaveBeenCalled();
  });

  it("clicking Scan my sessions triggers exactly one summary fetch and one stream open", async () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = doneStream(SCORECARD);
    render(<Reveal apiBase="" mode="first-run" onDismiss={() => {}} openStream={openStream} />);

    fireEvent.click(screen.getByRole("button", { name: "Scan my sessions" }));
    await act(async () => {});

    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledTimes(1);
  });
});

describe("Reveal — ceremony (existing user)", () => {
  it("fetches immediately with no consent gate, and a dismiss button calls onDismiss", async () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = doneStream(SCORECARD);
    const onDismiss = vi.fn();
    render(<Reveal apiBase="" mode="ceremony" onDismiss={onDismiss} openStream={openStream} />);

    expect(screen.queryByText(/Scan my sessions/)).toBeNull();
    await act(async () => {});
    expect(summarySpy).toHaveBeenCalledTimes(1);
    expect(openStream).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Take me to my console" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the migration headline, but never in first-run mode", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = doneStream(SCORECARD);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);
    expect(await screen.findByText(
      "AgentGem has a new home screen — here's what your sessions add up to.",
    )).toBeTruthy();

    cleanup();
    render(<Reveal apiBase="" mode="first-run" onDismiss={() => {}} openStream={openStream} />);
    expect(screen.queryByText(/new home screen/)).toBeNull();
  });
});

describe("Reveal — fire-gate branches", () => {
  it("truly cold (usage empty + Claude below gate): prospecting copy, no hero", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(COLD_SUMMARY);
    const openStream = vi.fn(() => () => {});
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    expect(await screen.findByText(
      "Not enough history to assay yet — AgentGem needs about 10 sessions. Keep working with your agent.",
    )).toBeTruthy();
    expect(screen.queryByText(/goldmine/i)).toBeNull();
  });

  it("Codex-heavy (usage present, Claude below gate): usage ledger renders, goldmine section is ONLY the Claude-only explainer, never prospecting copy", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(CODEX_HEAVY_SUMMARY);
    const openStream = vi.fn(() => () => {});
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    expect(await screen.findByText("workflow analysis reads your Claude sessions · usage covers Claude + Codex")).toBeTruthy();
    expect(await screen.findByText("412")).toBeTruthy(); // usage-half ledger renders real numbers
    expect(screen.queryByText(/Not enough history to assay yet/)).toBeNull();
  });

  it("rich (gate clear, scan done): renders the literal hero + subline figures and the CTA candidate", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const openStream = doneStream(SCORECARD);
    const { container } = render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    // Wait on the kicker (a unique exact string) rather than a digit-bearing regex —
    // with prefers-reduced-motion forced (see the top-of-file beforeEach), the hero's
    // final figures and the aria-live sr-only sentence both land in the same tick and
    // share overlapping substrings ("17 reusable workflows" etc.), so digit assertions
    // below are scoped to the hero heading specifically to avoid ambiguous matches.
    expect(await screen.findByText("You're sitting on a goldmine:")).toBeTruthy();
    const hero = within(container.querySelector(".reveal-hero")!);
    expect(hero.getByText(/17 reusable workflows/)).toBeTruthy();
    expect(hero.getByText(/6 battle-tested/)).toBeTruthy();
    expect(hero.getByText(/4 ready to share/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn your top workflow into a Gem" })).toBeTruthy();
    expect(screen.getByText("assembled now — deep distill keeps improving it in the background.")).toBeTruthy();
    expect(screen.getByText(/Ship a feature branch/)).toBeTruthy();
    expect(screen.getByText(/from 12 sessions/)).toBeTruthy();
    expect(screen.getByText(/Still unmined: no testing workflow yet · deploy steps never captured/)).toBeTruthy();
    expect(screen.getByText("workflow analysis reads your Claude sessions · usage covers Claude + Codex")).toBeTruthy();
    // Honesty scope clause — the scorecard silently caps discovery at the most
    // recent `projectsScanned` projects, so the ledger must say so.
    expect(screen.getByText(`across your ${SUMMARY.projectsScanned} most recent projects`)).toBeTruthy();
  });

  it("renders the scope clause with the summary's real projectsScanned value (not the mockup's sample)", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue({ ...SUMMARY, projectsScanned: 12 });
    const openStream = doneStream(SCORECARD);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    expect(await screen.findByText("across your 12 most recent projects")).toBeTruthy();
  });

  it("omits the scope clause when projectsScanned is 0", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue({ ...SUMMARY, projectsScanned: 0 });
    const openStream = doneStream(SCORECARD);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    await screen.findByText("You're sitting on a goldmine:");
    expect(screen.queryByText(/most recent projects/)).toBeNull();
  });

  it("sparse (portable=0): suppresses the ready-to-share clause and shows the earn-it line", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const sparse: Scorecard = { ...SCORECARD, portable: 0 };
    const openStream = doneStream(sparse);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    await screen.findByText("You're sitting on a goldmine:");
    expect(screen.queryByText(/ready to share/)).toBeNull();
    expect(screen.getByText(
      "nothing portable yet — battle-tested workflows become portable when they run outside this machine",
    )).toBeTruthy();
  });

  it("sparse (battleTested=0): suppresses the battle-tested clause and shows its own earn-it line", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const sparse: Scorecard = { ...SCORECARD, battleTested: 0 };
    const openStream = doneStream(sparse);
    const { container } = render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    await screen.findByText("You're sitting on a goldmine:");
    // The hero's own "N battle-tested" clause is gone (the earn-it line below still
    // contains the word "battle-tested" in prose, so match on the digit-prefixed form,
    // scoped to the hero heading — the sr-only sentence never mentions battle-tested
    // at all here since the count is 0, so no ambiguity to worry about there).
    expect(screen.queryByText(/\d+ battle-tested/)).toBeNull();
    expect(screen.getByText(
      "none battle-tested yet — workflows earn it by proving out across sessions.",
    )).toBeTruthy();
    // portable is still > 0 in this fixture, so its clause still renders normally —
    // scoped to the hero heading since the sr-only sentence shares this substring too.
    const hero = within(container.querySelector(".reveal-hero")!);
    expect(hero.getByText(/\d+ ready to share/)).toBeTruthy();
  });

  it("sparse (both battleTested=0 and portable=0): renders one combined earn-it line, not two", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const sparse: Scorecard = { ...SCORECARD, battleTested: 0, portable: 0 };
    const openStream = doneStream(sparse);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    await screen.findByText("You're sitting on a goldmine:");
    expect(screen.queryByText(/\d+ battle-tested/)).toBeNull();
    expect(screen.queryByText(/\d+ ready to share/)).toBeNull();
    expect(document.querySelectorAll(".reveal-earnit").length).toBe(1);
    expect(screen.getByText(
      "nothing battle-tested or portable yet — workflows earn both by proving out across sessions, then running outside this machine",
    )).toBeTruthy();
  });
});

describe("Reveal — CTA build (Task 6)", () => {
  const HOME_STATE: routes.HomeState = { unlocked: false, existingUser: true, revealSeen: false };
  const GEM: routes.Gem = {
    name: "Ship-a-feature-branch",
    createdFrom: "/home/.claude",
    artifacts: [{ type: "skill", name: "Ship-a-feature-branch" }],
    checks: [],
    requiredSecrets: [],
  };

  function setUpRich() {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    vi.spyOn(routes.homeStateRoute, "call").mockResolvedValue(HOME_STATE);
    const setHomeStateSpy = vi.spyOn(routes.setHomeStateRoute, "call").mockResolvedValue(HOME_STATE);
    const openStream = doneStream(SCORECARD);
    return { setHomeStateSpy, openStream };
  }

  it("click disables the CTA and posts scorecard/build exactly once, even on a synchronous double-click", async () => {
    const { openStream } = setUpRich();
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call").mockReturnValue(new Promise(() => {})); // never resolves
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    const cta = await screen.findByRole("button", { name: "Turn your top workflow into a Gem" });
    fireEvent.click(cta);
    fireEvent.click(cta);
    await act(async () => {});

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][1]).toEqual({
      body: { name: "Ship-a-feature-branch", selections: [{ root: "/p", keys: ["a"] }] },
    });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
  });

  it("success: renders the ceremony in place of the reveal body, and posts unlock + revealSeen", async () => {
    const { openStream, setHomeStateSpy } = setUpRich();
    vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn your top workflow into a Gem" }));

    expect(await screen.findByText("Ship-a-feature-branch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Curate" })).toBeTruthy();
    // The ceremony replaces the normal reveal body — the hero/CTA are gone, and the
    // returning-user dismiss button doesn't reappear alongside it.
    expect(document.querySelector(".reveal-hero")).toBeNull();
    expect(screen.queryByRole("button", { name: "Turn your top workflow into a Gem" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Take me to my console" })).toBeNull();

    await act(async () => {});
    const bodies = setHomeStateSpy.mock.calls.map((c) => c[1]?.body);
    expect(bodies).toContainEqual({ unlocked: true });
    expect(bodies).toContainEqual({ revealSeen: true });
  });

  it("build failure: preserves the candidate, shows the utility error line, and retry re-invokes the build", async () => {
    const { openStream } = setUpRich();
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    const cta = await screen.findByRole("button", { name: "Turn your top workflow into a Gem" });
    fireEvent.click(cta);

    expect(await screen.findByText("couldn't assemble the gem — try again")).toBeTruthy();
    expect(screen.getByText(/Ship a feature branch/)).toBeTruthy(); // candidate still shown
    expect((cta as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(cta);
    await screen.findByText("Ship-a-feature-branch");
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it("enrichment (background distill) rejection is silenced and never unmounts the ceremony", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { openStream } = setUpRich();
    vi.spyOn(routes.scorecardBuildRoute, "call").mockResolvedValue(GEM);
    vi.spyOn(routes.playbookPrepareRoute, "call").mockRejectedValue(new Error("distill unavailable"));
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn your top workflow into a Gem" }));
    expect(await screen.findByText("Ship-a-feature-branch")).toBeTruthy();

    await act(async () => {});
    expect(errSpy).toHaveBeenCalled();
    expect(screen.getByText("Ship-a-feature-branch")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open in Curate" })).toBeTruthy();
  });
});

describe("Reveal — choose a different candidate", () => {
  const HOME_STATE: routes.HomeState = { unlocked: false, existingUser: true, revealSeen: false };

  function setUpRich() {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    vi.spyOn(routes.homeStateRoute, "call").mockResolvedValue(HOME_STATE);
    vi.spyOn(routes.setHomeStateRoute, "call").mockResolvedValue(HOME_STATE);
    return { openStream: doneStream(SCORECARD) };
  }

  it("is collapsed by default; toggling it renders the top-5 candidates (name + session count), no new fetch", async () => {
    const { openStream } = setUpRich();
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);
    await screen.findByText("You're sitting on a goldmine:");

    expect(screen.queryByText("Older workflow")).toBeNull();
    const toggle = screen.getByRole("button", { name: "choose a different one" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = document.querySelector(".reveal-candidate-list") as HTMLElement;
    expect(within(list).getByText("Ship a feature branch")).toBeTruthy();
    expect(within(list).getByText("from 12 sessions")).toBeTruthy();
    expect(within(list).getByText("Older workflow")).toBeTruthy();
    expect(within(list).getByText("from 3 sessions")).toBeTruthy();
    // No fetch beyond the two the reveal already made to load — the list is
    // re-derived from the in-memory scorecard, not a new request.
    expect(routes.homeSummaryRoute.call).toHaveBeenCalledTimes(1);
  });

  it("selecting an alternative swaps the CTA's shown candidate, collapses the list, and targets that workflow's key on build", async () => {
    const { openStream } = setUpRich();
    const buildSpy = vi.spyOn(routes.scorecardBuildRoute, "call").mockReturnValue(new Promise(() => {}));
    vi.spyOn(routes.playbookPrepareRoute, "call").mockResolvedValue({ skills: [], lessons: [], root: "/p", degraded: false, preparing: false });
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);
    await screen.findByText("You're sitting on a goldmine:");

    fireEvent.click(screen.getByRole("button", { name: "choose a different one" }));
    fireEvent.click(screen.getByRole("button", { name: /Older workflow/ }));

    // List collapses after selection.
    expect(document.querySelector(".reveal-candidate-list")).toBeNull();
    // The CTA's candidate line now shows the selected workflow, not the default top pick.
    expect(screen.getByText("Older workflow — from 3 sessions")).toBeTruthy();
    expect(screen.queryByText(/^Ship a feature branch —/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Turn your top workflow into a Gem" }));
    await act(async () => {});
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(buildSpy.mock.calls[0][1]).toEqual({
      body: { name: "Older-workflow", selections: [{ root: "/p", keys: ["b"] }] },
    });
  });
});

describe("Reveal — hard failure", () => {
  it("shows a diagnostic with the failed path and Try again re-fetches", async () => {
    const summarySpy = vi.spyOn(routes.homeSummaryRoute, "call")
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(SUMMARY);
    const openStream = doneStream(SCORECARD);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    expect(await screen.findByText("/api/home/summary")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("You're sitting on a goldmine:");
    expect(summarySpy).toHaveBeenCalledTimes(2);
  });

  // Fix (final-review P0 sweep, item 5): summary succeeding but the scorecard STREAM
  // failing used to trigger the same full-page DiagnosticBlock as a summary failure,
  // discarding the already-rendered usage ledger. Now only the goldmine/scorecard
  // section itself degrades — the ledger (and masthead/dismiss) stay up.
  it("summary ok + scorecard stream failed: usage ledger still renders, with a scoped diagnostic (working retry) in place of just the goldmine section", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    let calls = 0;
    const openStream = vi.fn((_client: unknown, onEvent: (e: ScorecardStreamEvent) => void) => {
      calls++;
      if (calls === 1) onEvent({ type: "failed", message: "stream connection error" });
      else onEvent({ type: "done", scorecard: SCORECARD, cached: false, updatedAt: 1 });
      return () => {};
    });
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    // The usage ledger rendered — a full-page diagnostic would have hidden it.
    expect(await screen.findByText("412")).toBeTruthy();
    // The diagnostic itself is scoped: it shows, but doesn't replace the ledger above.
    expect(screen.getByText("/api/scorecard/stream")).toBeTruthy();
    expect(screen.getByText("Couldn't load your session reveal.")).toBeTruthy();
    // Ceremony mode's own chrome (migration headline + dismiss) is untouched.
    expect(screen.getByText("AgentGem has a new home screen — here's what your sessions add up to.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Take me to my console" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("You're sitting on a goldmine:");
    expect(openStream).toHaveBeenCalledTimes(2);
  });
});
