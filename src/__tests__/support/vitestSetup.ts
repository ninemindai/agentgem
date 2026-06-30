// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Global test fixture. Redirect HOME + AGENTGEM_HOME to a fresh, EMPTY temp dir so
// any test that exercises the DEFAULT scan/config path — resolveDirs() ->
// homedir()/.claude, agentgemHome() -> ~/.agentgem — reads a controlled empty store
// instead of the developer's real ~/.claude. The real store made those tests slow,
// flaky under full-suite IO concurrency (15s timeouts), and a no-op in CI (empty
// store). An empty fixture keeps the no-dirs scan deterministic (returns []) and
// fast everywhere. Tests that pass explicit dirs or inject deps are unaffected —
// this only changes the *default* root the production code resolves.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agentgem-test-home-"));
mkdirSync(join(home, ".claude", "projects"), { recursive: true });
mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
process.env.HOME = home;
process.env.AGENTGEM_HOME = home;
process.on("exit", () => {
  try { rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
});
