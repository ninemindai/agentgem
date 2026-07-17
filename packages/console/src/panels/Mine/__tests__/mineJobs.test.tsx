import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, renderHook } from "@testing-library/react";
afterEach(cleanup);
import * as activityModule from "../../../notify/ActivityProvider.js";
import type { ActivityRun } from "../../../notify/ActivityProvider.js";
import { decodeRubricParamsKey, useMineRubricRuns } from "../mineJobs.js";
import { JobsStrip } from "../JobsStrip.js";

describe("decodeRubricParamsKey", () => {
  it("decodes a project-scope key with empty sessionId", () => {
    expect(decodeRubricParamsKey("context-hygiene:project:/work/app:")).toEqual({
      rubric: "context-hygiene", scope: "project", root: "/work/app", sessionId: "",
    });
  });

  it("decodes a session-scope key with all 4 parts", () => {
    expect(decodeRubricParamsKey("team-hygiene:session::sess-123")).toEqual({
      rubric: "team-hygiene", scope: "session", root: "", sessionId: "sess-123",
    });
  });

  it("decodes an all-scope key with empty root and session", () => {
    expect(decodeRubricParamsKey("team-hygiene:all::")).toEqual({
      rubric: "team-hygiene", scope: "all", root: "", sessionId: "",
    });
  });
});

const run = (overrides: Partial<ActivityRun> = {}): ActivityRun => ({
  id: "r1", kind: "rubric", paramsKey: "context-hygiene:project:/work/app:", status: "running", phase: "scanning", startedAt: 1,
  ...overrides,
});

describe("JobsStrip", () => {
  it("renders nothing when there are no running rubric runs", () => {
    const { container } = render(<JobsStrip runs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when all runs are done/failed", () => {
    const runs = [
      { id: "r1", rubric: "a", scope: "all", root: "", sessionId: "", status: "done" as const, phase: "", startedAt: 1 },
      { id: "r2", rubric: "b", scope: "all", root: "", sessionId: "", status: "failed" as const, phase: "", startedAt: 2 },
    ];
    const { container } = render(<JobsStrip runs={runs} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the strip with rubric/phase text and a #/rubrics link for a running run", () => {
    render(<JobsStrip runs={[
      { id: "r1", rubric: "context-hygiene", scope: "project", root: "/work/app", sessionId: "", status: "running", phase: "scanning", startedAt: 1 },
    ]} />);
    expect(screen.getByText(/Re-scoring/)).toBeTruthy();
    expect(screen.getByText(/context-hygiene/)).toBeTruthy();
    expect(screen.getByText(/scanning/)).toBeTruthy();
    const link = screen.getByText("view queue ↗") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/rubrics");
  });

  it("summarizes multiple running runs", () => {
    render(<JobsStrip runs={[
      { id: "r1", rubric: "a", scope: "all", root: "", sessionId: "", status: "running", phase: "p1", startedAt: 1 },
      { id: "r2", rubric: "b", scope: "all", root: "", sessionId: "", status: "running", phase: "p2", startedAt: 2 },
    ]} />);
    expect(screen.getByText("2 rubric runs in progress")).toBeTruthy();
  });
});

describe("useMineRubricRuns", () => {
  it("keeps only kind:rubric runs and decodes their paramsKey", () => {
    vi.spyOn(activityModule, "useActivity").mockReturnValue({
      runs: [
        run({ id: "r1", paramsKey: "context-hygiene:project:/work/app:" }),
        run({ id: "r2", kind: "insights", paramsKey: "irrelevant" }),
        run({ id: "r3", paramsKey: "team-hygiene:all::", status: "done" }),
      ],
    });

    const { result } = renderHook(() => useMineRubricRuns());

    expect(result.current).toEqual([
      { id: "r1", rubric: "context-hygiene", scope: "project", root: "/work/app", sessionId: "", status: "running", phase: "scanning", startedAt: 1 },
      { id: "r3", rubric: "team-hygiene", scope: "all", root: "", sessionId: "", status: "done", phase: "scanning", startedAt: 1 },
    ]);
  });
});
