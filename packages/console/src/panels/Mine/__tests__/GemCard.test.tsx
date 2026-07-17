import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
afterEach(cleanup);
import { GemCard } from "../GemCard.js";
import type { WorkflowCardModel } from "../groupWorkflows.js";

const card: WorkflowCardModel = {
  root: "/r/a", projectLabel: "react-app", key: "wf-1", name: "Deploy to staging",
  confidence: "high", portable: true, sessions: 6, lastSeenMs: 0,
};

const noop = () => {};

describe("GemCard", () => {
  it("renders the name as primary text and provenance with session count + project label", () => {
    render(<GemCard card={card} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText("Deploy to staging")).toBeTruthy();
    expect(screen.getByText("distilled from 6 sessions · react-app")).toBeTruthy();
  });

  it("renders singular session wording for 1 session", () => {
    render(<GemCard card={{ ...card, sessions: 1 }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText("distilled from 1 session · react-app")).toBeTruthy();
  });

  it("renders 'distilled · {label}' when sessions is 0", () => {
    render(<GemCard card={{ ...card, sessions: 0 }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText("distilled · react-app")).toBeTruthy();
  });

  it("shows a Run hygiene affordance when score is null and calls onRunHygiene with the card", () => {
    const onRunHygiene = vi.fn();
    render(<GemCard card={card} score={null} onRunHygiene={onRunHygiene} onOpen={noop} onDistill={noop} onShare={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /run hygiene/i }));
    expect(onRunHygiene).toHaveBeenCalledWith(card);
  });

  it("shows a Run hygiene affordance when score is undefined", () => {
    render(<GemCard card={card} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByRole("button", { name: /run hygiene/i })).toBeTruthy();
  });

  it("shows a re-scoring indicator when score is 'running'", () => {
    render(<GemCard card={card} score="running" onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText(/re-scoring/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run hygiene/i })).toBeNull();
  });

  it("renders a good-toned score value + label", () => {
    const { container } = render(
      <GemCard card={card} score={{ value: 92, tone: "good", label: "hygiene" }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />
    );
    const el = screen.getByText("92");
    expect(el.className).toContain("gem-card__score--good");
    expect(screen.getByText("hygiene")).toBeTruthy();
    expect(container.querySelector(".gem-card__score--warn")).toBeNull();
  });

  it("renders a warn-toned score value", () => {
    render(<GemCard card={card} score={{ value: 41, tone: "warn", label: "hygiene" }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    const el = screen.getByText("41");
    expect(el.className).toContain("gem-card__score--warn");
  });

  it("shows both badges for a high-confidence portable card", () => {
    render(<GemCard card={card} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText("battle-tested")).toBeTruthy();
    expect(screen.getByText("portable")).toBeTruthy();
  });

  it("shows only the battle-tested badge for high-confidence non-portable card", () => {
    render(<GemCard card={{ ...card, portable: false }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText("battle-tested")).toBeTruthy();
    expect(screen.queryByText("portable")).toBeNull();
  });

  it("shows neither badge for a medium-confidence non-portable card", () => {
    render(<GemCard card={{ ...card, confidence: "medium", portable: false }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.queryByText("battle-tested")).toBeNull();
    expect(screen.queryByText("portable")).toBeNull();
  });

  it("calls onOpen, onDistill, onShare from their respective buttons", () => {
    const onOpen = vi.fn();
    const onDistill = vi.fn();
    const onShare = vi.fn();
    render(<GemCard card={card} onRunHygiene={noop} onOpen={onOpen} onDistill={onDistill} onShare={onShare} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.click(screen.getByRole("button", { name: /distill/i }));
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    expect(onOpen).toHaveBeenCalledWith(card);
    expect(onDistill).toHaveBeenCalledWith(card);
    expect(onShare).toHaveBeenCalledWith(card);
  });

  it("puts a very long name in the title attribute for truncation", () => {
    const longName = "A".repeat(120);
    render(<GemCard card={{ ...card, name: longName }} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop} />);
    expect(screen.getByText(longName).getAttribute("title")).toBe(longName);
  });

  it("renders children when expanded", () => {
    render(
      <GemCard card={card} expanded onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop}>
        <div>detail body</div>
      </GemCard>
    );
    expect(screen.getByText("detail body")).toBeTruthy();
  });

  it("does not render children when not expanded", () => {
    render(
      <GemCard card={card} onRunHygiene={noop} onOpen={noop} onDistill={noop} onShare={noop}>
        <div>detail body</div>
      </GemCard>
    );
    expect(screen.queryByText("detail body")).toBeNull();
  });
});
