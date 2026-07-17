// Mine-local jobs strip: re-scopes the existing global activity feed (ActivityProvider,
// already polling /api/report/runs every 5s) down to rubric runs, decoded into their
// (rubric, scope, root, sessionId) parts. No new polling — this is a pure read model
// over useActivity(). See Rubrics/index.tsx `startRun` for the paramsKey format:
// `${rubric}:${scope}:${root ?? ""}:${sessionId ?? ""}`.
import { useActivity, type ActivityRun } from "../../notify/ActivityProvider.js";

export type MineRubricRun = {
  id: string;
  rubric: string;
  scope: string;
  root: string;
  sessionId: string;
  status: ActivityRun["status"];
  phase: string;
  startedAt: number;
};

/** Split a rubric paramsKey into its parts. Unix `root` paths never contain ":", so a
 *  plain split is safe. Defensive: more than 4 parts joins the remainder back into
 *  sessionId rather than dropping it. */
export function decodeRubricParamsKey(paramsKey: string): { rubric: string; scope: string; root: string; sessionId: string } {
  const parts = paramsKey.split(":");
  const [rubric = "", scope = "", root = "", ...rest] = parts;
  return { rubric, scope, root, sessionId: rest.join(":") };
}

/** Rubric-only slice of the global activity feed, decoded for the Mine jobs strip.
 *  Reuses ActivityProvider's existing poll — no new polling here. */
export function useMineRubricRuns(): MineRubricRun[] {
  const { runs } = useActivity();
  return runs
    .filter((r) => r.kind === "rubric")
    .map((r) => ({ id: r.id, ...decodeRubricParamsKey(r.paramsKey), status: r.status, phase: r.phase, startedAt: r.startedAt }));
}
