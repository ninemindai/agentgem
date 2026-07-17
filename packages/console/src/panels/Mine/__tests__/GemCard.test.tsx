import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { GemCard } from "../GemCard.js";
import type { UnifiedGem } from "../unifiedGems.js";

const workflowGem: UnifiedGem = {
  id: "workflow:/r/a:wf-1", type: "workflow", name: "Deploy to staging",
  provenance: "distilled from 6 sessions · react-app", maturity: "raw", value: "worth-sharing",
  signal: { kind: "confidence", confidence: "high", portable: true }, scorable: true,
  root: "/r/a", key: "wf-1",
};

const skillGem: UnifiedGem = {
  id: "skill:pdf", type: "skill", name: "pdf", provenance: "used in 3 sessions",
  maturity: "distilled", value: "battle-tested",
  signal: { kind: "usage", invocations: 3, lastUsedMs: 10 }, scorable: true,
};

const subagentGem: UnifiedGem = {
  id: "subagent:reviewer", type: "subagent", name: "reviewer", provenance: "not yet used",
  maturity: "distilled", value: "reusable",
  signal: { kind: "usage", invocations: 0, lastUsedMs: null }, scorable: true,
};

const lessonGem: UnifiedGem = {
  id: "lesson:onboarding", type: "lesson", name: "onboarding", provenance: "not yet used",
  maturity: "distilled", value: "reusable",
  signal: { kind: "usage", invocations: 0, lastUsedMs: null }, scorable: false,
};

const rubricGem: UnifiedGem = {
  id: "rubric:team-hygiene", type: "rubric", name: "team-hygiene", provenance: "not yet used",
  maturity: "distilled", value: "reusable",
  signal: { kind: "usage", invocations: 0, lastUsedMs: null }, scorable: false,
};

const miniappGem: UnifiedGem = {
  id: "miniapp:wordle-clone", type: "miniapp", name: "wordle-clone", provenance: "puzzle",
  maturity: "distilled", value: "reusable",
  signal: { kind: "genre", genre: "puzzle" }, scorable: false,
};

const sharedGem: UnifiedGem = {
  id: "skill:shared-one", type: "skill", name: "shared-one", provenance: "used in 1 session",
  maturity: "shared", value: "worth-sharing",
  signal: { kind: "usage", invocations: 1, lastUsedMs: 10 }, scorable: true,
};

const noop = () => {};
const noopHandlers = { onRunHygiene: noop, onOpen: noop, onDistill: noop, onShare: noop, onPlay: noop };

describe("GemCard", () => {
  it("renders the name as primary text and provenance", () => {
    render(<GemCard gem={workflowGem} {...noopHandlers} />);
    expect(screen.getByText("Deploy to staging")).toBeTruthy();
    expect(screen.getByText("distilled from 6 sessions · react-app")).toBeTruthy();
  });

  it("shows a Run hygiene affordance for a scorable gem when score is null and calls onRunHygiene with the gem", () => {
    const onRunHygiene = vi.fn();
    render(<GemCard gem={workflowGem} score={null} {...noopHandlers} onRunHygiene={onRunHygiene} />);
    fireEvent.click(screen.getByRole("button", { name: /run hygiene/i }));
    expect(onRunHygiene).toHaveBeenCalledWith(workflowGem);
  });

  it("shows a Run hygiene affordance when score is undefined", () => {
    render(<GemCard gem={workflowGem} {...noopHandlers} />);
    expect(screen.getByRole("button", { name: /run hygiene/i })).toBeTruthy();
  });

  it("shows a re-scoring indicator when score is 'running'", () => {
    render(<GemCard gem={workflowGem} score="running" {...noopHandlers} />);
    expect(screen.getByText(/re-scoring/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run hygiene/i })).toBeNull();
  });

  it("renders a good-toned score value + label", () => {
    render(<GemCard gem={workflowGem} score={{ value: 92, tone: "good", label: "hygiene" }} {...noopHandlers} />);
    const el = screen.getByText("92");
    expect(el.className).toContain("gem-card__score--good");
    expect(screen.getByText("hygiene")).toBeTruthy();
  });

  it("renders a warn-toned score value", () => {
    render(<GemCard gem={workflowGem} score={{ value: 41, tone: "warn", label: "hygiene" }} {...noopHandlers} />);
    const el = screen.getByText("41");
    expect(el.className).toContain("gem-card__score--warn");
  });

  it("shows both badges for a high-confidence portable workflow", () => {
    render(<GemCard gem={workflowGem} {...noopHandlers} />);
    expect(screen.getByText("battle-tested")).toBeTruthy();
    expect(screen.getByText("portable")).toBeTruthy();
  });

  it("shows only the battle-tested badge for high-confidence non-portable gem", () => {
    const gem: UnifiedGem = { ...workflowGem, signal: { kind: "confidence", confidence: "high", portable: false } };
    render(<GemCard gem={gem} {...noopHandlers} />);
    expect(screen.getByText("battle-tested")).toBeTruthy();
    expect(screen.queryByText("portable")).toBeNull();
  });

  it("shows neither badge for a medium-confidence non-portable gem", () => {
    const gem: UnifiedGem = { ...workflowGem, signal: { kind: "confidence", confidence: "medium", portable: false } };
    render(<GemCard gem={gem} {...noopHandlers} />);
    expect(screen.queryByText("battle-tested")).toBeNull();
    expect(screen.queryByText("portable")).toBeNull();
  });

  it("puts a very long name in the title attribute for truncation", () => {
    const longName = "A".repeat(120);
    render(<GemCard gem={{ ...workflowGem, name: longName }} {...noopHandlers} />);
    expect(screen.getByText(longName).getAttribute("title")).toBe(longName);
  });

  it("renders children when expanded", () => {
    render(
      <GemCard gem={workflowGem} expanded {...noopHandlers}>
        <div>detail body</div>
      </GemCard>
    );
    expect(screen.getByText("detail body")).toBeTruthy();
  });

  it("does not render children when not expanded", () => {
    render(
      <GemCard gem={workflowGem} {...noopHandlers}>
        <div>detail body</div>
      </GemCard>
    );
    expect(screen.queryByText("detail body")).toBeNull();
  });

  // ── Per-type action matrix ──────────────────────────────────────────────

  it("workflow: shows Open, Distill, Share and calls each with the gem", () => {
    const onOpen = vi.fn(), onDistill = vi.fn(), onShare = vi.fn();
    render(<GemCard gem={workflowGem} {...noopHandlers} onOpen={onOpen} onDistill={onDistill} onShare={onShare} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: /distill/i }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onOpen).toHaveBeenCalledWith(workflowGem);
    expect(onDistill).toHaveBeenCalledWith(workflowGem);
    expect(onShare).toHaveBeenCalledWith(workflowGem);
  });

  it("skill: shows the hygiene score slot and Open, no Distill/Share", () => {
    render(<GemCard gem={skillGem} score={null} {...noopHandlers} />);
    expect(screen.getByRole("button", { name: /run hygiene/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: /distill/i })).toBeNull();
  });

  it("subagent: shows the hygiene score slot and Open, no Distill/Share", () => {
    render(<GemCard gem={subagentGem} score={null} {...noopHandlers} />);
    expect(screen.getByRole("button", { name: /run hygiene/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /distill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
  });

  it("lesson: shows Open, no hygiene slot, no Distill/Share", () => {
    render(<GemCard gem={lessonGem} {...noopHandlers} />);
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: /run hygiene/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /distill/i })).toBeNull();
    expect(screen.getByText("0 uses")).toBeTruthy();
  });

  it("rubric: shows Open, no hygiene slot, no Distill/Share", () => {
    render(<GemCard gem={rubricGem} {...noopHandlers} />);
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: /run hygiene/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /distill/i })).toBeNull();
  });

  it("miniapp: shows Play only, no Open/Distill/Share/hygiene, and shows the genre chip in the score slot", () => {
    const onPlay = vi.fn();
    render(<GemCard gem={miniappGem} {...noopHandlers} onPlay={onPlay} />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(onPlay).toHaveBeenCalledWith(miniappGem);
    expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.queryByRole("button", { name: /distill/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /run hygiene/i })).toBeNull();
    expect(screen.getAllByText("puzzle")).toHaveLength(2); // provenance line + genre chip
  });

  it("a shared gem shows the shared badge", () => {
    render(<GemCard gem={sharedGem} score={null} {...noopHandlers} />);
    expect(screen.getByText("shared")).toBeTruthy();
  });

  it("usage signal renders invocation count in the score slot for non-scorable gems", () => {
    render(<GemCard gem={{ ...lessonGem, signal: { kind: "usage", invocations: 5, lastUsedMs: 10 } }} {...noopHandlers} />);
    expect(screen.getByText("5 uses")).toBeTruthy();
  });
});
