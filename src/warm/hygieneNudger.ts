// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/hygieneNudger.ts
//
// Per-session escalation glue for the ambient nudge. Reuses #176's buildTickEvents
// for the entire fire-on-climb + advice-pick logic; this only holds the per-session
// last-verdict state and calls notify on a fire. A per-file try/catch keeps a
// half-written transcript from killing the daemon or skipping the other files.
import { basename } from "node:path";
import { buildTickEvents, type Verdict } from "@agentgem/app/watchHygieneNudge";
import type { HygieneReport } from "@agentgem/app/sessionHygieneCore";
import { createLogger } from "@agentgem/base";

const log = createLogger("warm");

export function createHygieneNudger(deps: {
  notify: (title: string, body: string) => void;
  reportForFile: (path: string) => HygieneReport;
}): { nudge(files: string[]): void } {
  const last = new Map<string, Verdict>();
  return {
    nudge(files: string[]): void {
      for (const file of files) {
        try {
          const report = deps.reportForFile(file);
          const id = report.meta.sessionId || file;
          const t = buildTickEvents(last.get(id) ?? null, report);
          if (t.nudge) deps.notify("AgentGem — context is heavy", `${basename(file)}: ${t.nudge.advice}`);
          last.set(id, t.nextVerdict);
        } catch (err) {
          log.warn("hygiene nudge skipped %s: %s", basename(file), (err as Error)?.message ?? err);
        }
      }
    },
  };
}
