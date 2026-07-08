// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MomentCard } from "./MomentCard.js";
import type { MomentHit } from "../../api/routes.js";

afterEach(() => cleanup());

const hit: MomentHit = {
  sessionId: "s1", agent: "claude", turn: 0,
  project: "agentgem", branch: "main", startMs: 1,
  snippet: "the ⌈prod⌉ db", score: -1, turnsMatched: 2,
};

describe("MomentCard", () => {
  it("highlights snippet markers and reports selection toggles", () => {
    const onToggle = vi.fn();
    render(<MomentCard hit={hit} picked={false} onToggle={onToggle} />);
    expect(screen.getByText("prod").tagName).toBe("MARK");
    expect(screen.getByText(/2 matching turns/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /prod db|moment/i }));
    expect(onToggle).toHaveBeenCalledWith("claude:s1");
  });

  it("renders project, branch, agent, and a relative timestamp", () => {
    render(<MomentCard hit={hit} picked={false} onToggle={vi.fn()} />);
    expect(screen.getByText("agentgem")).toBeTruthy();
    expect(screen.getByText("main")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
  });

  it("the Open-turn link deep-links to the turn-level session route", () => {
    render(<MomentCard hit={hit} picked={false} onToggle={vi.fn()} />);
    const link = screen.getByRole("link", { name: /open turn/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/sessions/claude/s1?turn=0");
  });

  it("clicking the Open-turn link does not also toggle selection", () => {
    const onToggle = vi.fn();
    render(<MomentCard hit={hit} picked={false} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("link", { name: /open turn/i }));
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("singular '1 matching turn' when only one turn matched", () => {
    render(<MomentCard hit={{ ...hit, turnsMatched: 1 }} picked={false} onToggle={vi.fn()} />);
    expect(screen.getByText(/1 matching turn$/)).toBeTruthy();
  });
});
