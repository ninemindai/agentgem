// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Regression for a Task 8 browser-verification finding: warm's own boot pass (see
// warm/schedule.ts) writes the exact cache files (transcript-index.db,
// global-usage-cache.json, etc.) that home/state.ts's existingUser heuristic checks
// for — via a `setTimeout(fn, 0)` fired right after the server starts. Verified live
// against a temp AGENTGEM_HOME: a genuinely brand-new install's FIRST `GET
// /api/home/state` (made by the console after page load) already saw those artifacts
// on disk, because the real browser round-trip to load the page always outlasts a
// deferred-to-next-tick timer. That flagged every fresh install existingUser:true —
// permanently latched — collapsing the intended first-run consent gate into the
// existing-user ceremony for 100% of new installs, not just this dev machine.
//
// The fix (src/index.ts's run() and src/client.ts's runClient()): call readState()
// synchronously, before startWarmSchedule(), so the true pre-boot snapshot is read and
// persisted before warm's boot pass can taint it. This test pins the ordering
// invariant directly against home/state.ts + warm/schedule.ts, without booting the
// full app.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readState } from "@agentgem/app/home/state";
import { startWarmSchedule } from "@agentgem/app/warm/schedule";
import { useHermeticHome } from "./support/hermeticHome.js";

let restoreHome: () => void;
let home: string;
beforeEach(() => { restoreHome = useHermeticHome(); home = process.env.AGENTGEM_HOME!; });
afterEach(() => { restoreHome(); });

// Stands in for warm's real cheap boot pass (orchestrator.ts writes this file for
// real) without pulling in the whole warm pipeline.
function warmBootPassWritesArtifact(): void {
  mkdirSync(join(home, ".agentgem"), { recursive: true });
  writeFileSync(join(home, ".agentgem", "transcript-index.db"), "");
}

describe("home-state boot ordering vs warm's boot pass", () => {
  it("readState() called BEFORE warm's boot pass latches existingUser:false permanently (the shipped order)", () => {
    const initial = readState(home); // mirrors run()/runClient()'s new pre-warm call
    expect(initial.existingUser).toBe(false);

    // Warm's boot pass (runNow fires synchronously here, matching its real
    // setTimeout(fn,0) immediacy) writes the artifact AFTER the snapshot was taken.
    startWarmSchedule({
      home,
      run: async () => { warmBootPassWritesArtifact(); },
      runNow: (fn) => fn(),
      setInterval: () => ({}), clearInterval: () => {},
    });

    // A later read (the console's actual first GET /api/home/state) must return the
    // ALREADY-persisted snapshot, not re-derive from the now-present artifact.
    const later = readState(home);
    expect(later.existingUser).toBe(false);
  });

  it("demonstrates the bug this ordering prevents: readState() called AFTER an artifact already exists latches existingUser:true", () => {
    // No pre-boot snapshot taken — this is the pre-fix shape, where the first read
    // only happens lazily on the console's request, by which point warm has run.
    warmBootPassWritesArtifact();
    const out = readState(home);
    expect(out.existingUser).toBe(true);
  });
});
