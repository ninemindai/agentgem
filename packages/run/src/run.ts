// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/run.ts
// Run the rendered eve project locally. Side-effecting orchestration (peer of workspaces.ts).
// Process spawning is injected via ProcessRunner so command/env/state logic is unit-testable.
// Shared helpers + the run `registry` live in ./runShared.js so every consumer reads the same state.
import { realRunner, runToEnd, ensureRunProject, pushLog, parseEveUrl, registry, EVE_BIN, type ProcessRunner, type RunState } from "./runShared.js";

export async function startLocal(name: string, runner: ProcessRunner = realRunner): Promise<RunState> {
  for (const e of registry.values()) {
    if (e.state.mode === "local" && e.state.state === "running") throw new Error("a local run is already active");
  }
  const state: RunState = { mode: "local", state: "installing", logTail: [] };
  registry.set(`${name}:eve`, { state });
  try {
    const runDir = await ensureRunProject(name, "eve", runner, state.logTail);
    state.state = "building";
    const buildCode = await runToEnd(runner, EVE_BIN(runDir), ["build"], runDir, process.env, state.logTail);
    if (buildCode !== 0) { state.state = "failed"; return state; }
    const handle = runner.spawn(EVE_BIN(runDir), ["start"], { cwd: runDir, env: process.env });
    registry.set(`${name}:eve`, { state, handle });
    state.state = "running";
    handle.onLine((line) => {
      pushLog(state.logTail, line);
      if (!state.url) { const u = parseEveUrl([line]); if (u) state.url = u; }
    });
    handle.onExit((code) => { if (state.state === "running") state.state = code === 0 ? "idle" : "failed"; });
    return state;
  } catch (err) {
    state.state = "failed";
    pushLog(state.logTail, err instanceof Error ? err.message : String(err));
    return state;
  }
}

export function stopLocal(name: string, target: string): { stopped: boolean } {
  const e = registry.get(`${name}:${target}`);
  if (!e?.handle) return { stopped: false };
  e.handle.kill();
  e.state.state = "idle";
  return { stopped: true };
}

export function getRunStatus(name: string, target: string): RunState {
  return registry.get(`${name}:${target}`)?.state ?? { mode: "local", state: "idle", logTail: [] };
}
