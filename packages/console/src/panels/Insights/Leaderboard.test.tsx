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
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="" onSearch={() => {}} />);
    expect(screen.getByText("brainstorming")).toBeTruthy();
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.getByText(/40 verified/i)).toBeTruthy();
  });
  it("calls onSelect with the row id when clicked", () => {
    const onSelect = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={onSelect} search="" onSearch={() => {}} />);
    fireEvent.click(screen.getByText("brainstorming"));
    expect(onSelect).toHaveBeenCalledWith("skill:superpowers/brainstorming");
  });
  it("calls onKind when a filter tab is clicked", () => {
    const onKind = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={onKind} selectedId={null} onSelect={() => {}} search="" onSearch={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Skill" }));
    expect(onKind).toHaveBeenCalledWith("skill");
  });

  it("shows only matching rows and a no-match message when nothing matches", () => {
    const onSearch = vi.fn();
    const { rerender } = render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="github" onSearch={onSearch} />);
    expect(screen.getByText("@mcp/github")).toBeTruthy();
    expect(screen.queryByText("brainstorming")).toBeNull();
    rerender(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="zzz" onSearch={onSearch} />);
    expect(screen.getByText(/no ingredients match/i)).toBeTruthy();
  });

  it("typing in the search box calls onSearch", () => {
    const onSearch = vi.fn();
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="" onSearch={onSearch} />);
    fireEvent.change(screen.getByLabelText("search ingredients"), { target: { value: "brain" } });
    expect(onSearch).toHaveBeenCalledWith("brain");
  });

  it("preserves the original rank number when filtered", () => {
    render(<Leaderboard rows={rows} kind="all" onKind={() => {}} selectedId={null} onSelect={() => {}} search="github" onSearch={() => {}} />);
    expect(screen.getByText("2")).toBeTruthy(); // @mcp/github is row #2 in the full list
  });
});
