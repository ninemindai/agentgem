import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Dashboard } from "./Dashboard.js";

afterEach(() => cleanup());

const payload = (layer: "global" | "project") => ({
  range: "all" as const, instructions: [], disabled: [],
  artifacts: [{ name: "demo", type: "skill" as const, source: layer === "project" ? "project" : "user", layer, contextTokens: 10, uses: 0, lastUsedMs: null, prune: true, change: { file: "x", key: "y" } }],
});

describe("Dashboard scope-aware eligibility", () => {
  it("in project scope, a project row is disable-eligible (checkbox present)", () => {
    render(<Dashboard data={payload("project")} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "project", root: "/r", label: "r" }} onScope={() => {}} />);
    expect(screen.getByLabelText("select demo")).toBeTruthy();
  });
  it("in project scope, a global row is advisory (no checkbox)", () => {
    render(<Dashboard data={payload("global")} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "project", root: "/r", label: "r" }} onScope={() => {}} />);
    expect(screen.queryByLabelText("select demo")).toBeNull();
  });
});

describe("Dashboard usageStale affordance", () => {
  it("shows the 'updating usage…' pill when usageStale is true", () => {
    render(<Dashboard data={{ ...payload("global"), usageStale: true }} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "global" }} onScope={() => {}} />);
    expect(screen.getByText("updating usage…")).toBeTruthy();
  });
  it("shows no pill when usage is fresh", () => {
    render(<Dashboard data={payload("global")} range="all" onRange={() => {}} pending={false} apiBase="" scope={{ kind: "global" }} onScope={() => {}} />);
    expect(screen.queryByText("updating usage…")).toBeNull();
  });
});
