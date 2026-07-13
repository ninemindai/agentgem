import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Mine } from "../index.js";

vi.mock("../WorkflowsView.js", () => ({ WorkflowsView: (p: { scope: string }) => <div>workflows:{p.scope}</div> }));
vi.mock("../OutcomesView.js", () => ({ OutcomesView: (p: { scope: string }) => <div>outcomes:{p.scope}</div> }));
vi.mock("../ProjectScope.js", () => ({ ProjectScope: (p: { onChange: (s: string) => void }) => <button onClick={() => p.onChange("/x")}>pick</button> }));

afterEach(() => { cleanup(); window.location.hash = ""; });
beforeEach(() => { window.location.hash = "#/mine"; });

describe("Mine shell", () => {
  it("shows Workflows by default", () => {
    render(<Mine apiBase="http://x" />);
    expect(screen.getByText("workflows:*")).toBeTruthy();
  });
  it("shows Outcomes at #/mine/outcomes", () => {
    window.location.hash = "#/mine/outcomes";
    render(<Mine apiBase="http://x" />);
    expect(screen.getByText("outcomes:*")).toBeTruthy();
  });
  it("propagates the shared scope to the active view", () => {
    render(<Mine apiBase="http://x" />);
    fireEvent.click(screen.getByText("pick"));
    expect(screen.getByText("workflows:/x")).toBeTruthy();
  });
});
