import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import * as routes from "../../api/routes.js";
import { Reveal } from "./Reveal.js";
import type { ScorecardStreamEvent } from "../Mine/scorecardStream.js";
import type { Scorecard } from "../../api/routes.js";

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
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    expect(await screen.findByText("You're sitting on a goldmine:")).toBeTruthy();
    expect(screen.getByText(/17 reusable workflows/)).toBeTruthy();
    expect(screen.getByText(/6 battle-tested/)).toBeTruthy();
    expect(screen.getByText(/4 ready to share/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn your top workflow into a Gem" })).toBeTruthy();
    expect(screen.getByText("assembled now — deep distill keeps improving it in the background.")).toBeTruthy();
    expect(screen.getByText(/Ship a feature branch/)).toBeTruthy();
    expect(screen.getByText(/from 12 sessions/)).toBeTruthy();
    expect(screen.getByText(/Still unmined: no testing workflow yet · deploy steps never captured/)).toBeTruthy();
    expect(screen.getByText("workflow analysis reads your Claude sessions · usage covers Claude + Codex")).toBeTruthy();
  });

  it("sparse (portable=0): suppresses the ready-to-share clause and shows the earn-it line", async () => {
    vi.spyOn(routes.homeSummaryRoute, "call").mockResolvedValue(SUMMARY);
    const sparse: Scorecard = { ...SCORECARD, portable: 0 };
    const openStream = doneStream(sparse);
    render(<Reveal apiBase="" mode="ceremony" onDismiss={() => {}} openStream={openStream} />);

    await screen.findByText(/17 reusable workflows/);
    expect(screen.queryByText(/ready to share/)).toBeNull();
    expect(screen.getByText(
      "nothing portable yet — battle-tested workflows become portable when they run outside this machine",
    )).toBeTruthy();
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
    await screen.findByText(/17 reusable workflows/);
    expect(summarySpy).toHaveBeenCalledTimes(2);
  });
});
