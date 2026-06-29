import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { MineWorkflows } from "../Workflows.js";
import type { Scorecard } from "../../../api/routes.js";

const SCORECARD: Scorecard = {
  breadth: 5, battleTested: 2, portable: 1, gaps: [], degraded: false, generatedAtMs: 0,
  projects: [
    {
      root: "/projects/alpha", label: "alpha",
      breadth: 3, battleTested: 2, portable: 1,
      workflows: [
        { key: "wf-a", name: "Deploy workflow", confidence: "high", portable: true },
        { key: "wf-b", name: "Test workflow", confidence: "medium", portable: false },
      ],
    },
    {
      root: "/projects/beta", label: "beta",
      breadth: 2, battleTested: 0, portable: 0,
      workflows: [
        { key: "wf-c", name: "Lint workflow", confidence: "low", portable: false },
      ],
    },
  ],
};

describe("MineWorkflows", () => {
  it("renders workflow names", () => {
    render(<MineWorkflows data={SCORECARD} onBuild={vi.fn()} building={false} result={null} error={null} />);
    expect(screen.getByText("Deploy workflow")).toBeTruthy();
    expect(screen.getByText("Test workflow")).toBeTruthy();
    expect(screen.getByText("Lint workflow")).toBeTruthy();
  });

  it("renders battle-tested badge for high confidence workflows", () => {
    render(<MineWorkflows data={SCORECARD} onBuild={vi.fn()} building={false} result={null} error={null} />);
    expect(screen.getByText("battle-tested")).toBeTruthy();
  });

  it("renders portable badge for portable workflows", () => {
    render(<MineWorkflows data={SCORECARD} onBuild={vi.fn()} building={false} result={null} error={null} />);
    expect(screen.getByText("portable")).toBeTruthy();
  });

  it("Build button is disabled when nothing is selected", () => {
    render(<MineWorkflows data={SCORECARD} onBuild={vi.fn()} building={false} result={null} error={null} />);
    const btn = screen.getByRole("button", { name: /build gem/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("calls onBuild with correct selections after toggling a checkbox", () => {
    const onBuild = vi.fn();
    render(<MineWorkflows data={SCORECARD} onBuild={onBuild} building={false} result={null} error={null} />);
    const checkbox = screen.getByRole("checkbox", { name: /deploy workflow/i });
    fireEvent.click(checkbox);
    const btn = screen.getByRole("button", { name: /build gem \(1\)/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onBuild).toHaveBeenCalledWith(
      [{ root: "/projects/alpha", keys: ["wf-a"] }],
      "goldmine-gem",
    );
  });

  it("renders success result", () => {
    render(
      <MineWorkflows
        data={SCORECARD}
        onBuild={vi.fn()}
        building={false}
        result={{ name: "my-gem", skills: ["deploy", "lint"] }}
        error={null}
      />,
    );
    expect(screen.getByText(/built/i)).toBeTruthy();
    expect(screen.getByText("my-gem")).toBeTruthy();
    expect(screen.getByText(/2 skills/i)).toBeTruthy();
  });
});
