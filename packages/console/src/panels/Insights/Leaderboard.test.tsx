import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Leaderboard } from "./Leaderboard.js";

afterEach(cleanup);

const rows = [
  { id: "skill:superpowers/brainstorming", kind: "skill", producers: 80, verifiedProducers: 40, invocations: 200, sessions: 90 },
  { id: "npx:@mcp/github", kind: "mcp", producers: 30, verifiedProducers: 9, invocations: 50, sessions: 25 },
];

describe("Leaderboard", () => {
  it("renders prettified rows with producer + verified counts", () => {
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText(/40 verified/i)).toBeTruthy();
  });
  it("calls onSelect with the row id when clicked", () => {
    const onSelect = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("brainstorming"));
    expect(onSelect).toHaveBeenCalledWith("skill:superpowers/brainstorming");
  });
  it("calls onKind when a filter tab is clicked", () => {
    const onKind = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={onKind} selectedId={null} onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Skill" }));
    expect(onKind).toHaveBeenCalledWith("skill");
  });
});
