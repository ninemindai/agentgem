// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Targeted hermetic-HOME fixture for tests that exercise the DEFAULT scan/config path
// (resolveDirs() -> homedir()/.claude, agentgemHome() -> ~/.agentgem). Point HOME +
// AGENTGEM_HOME at a fresh EMPTY temp dir so the no-dirs scan returns [] fast and
// deterministically, instead of reading the developer's real, huge ~/.claude — the source
// of 15s timeouts under full-suite IO concurrency (in CI the real store is empty, so this
// is a local-only flake). Call in beforeAll and invoke the returned restore() in afterAll.
//
// Deliberately NOT a global setupFile: the bubblewrap/seatbelt sandbox boundary tests must
// keep the real HOME — they rely on $HOME being read-only inside the jail, and a HOME under
// the system tmpdir would fall inside bwrap's writable `--bind /tmp` and break containment.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useHermeticHome(): () => void {
  const prevHome = process.env.HOME;
  const prevAgentgemHome = process.env.AGENTGEM_HOME;
  const home = mkdtempSync(join(tmpdir(), "agentgem-test-home-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
  process.env.HOME = home;
  process.env.AGENTGEM_HOME = home;
  return () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAgentgemHome === undefined) delete process.env.AGENTGEM_HOME;
    else process.env.AGENTGEM_HOME = prevAgentgemHome;
    rmSync(home, { recursive: true, force: true });
  };
}
