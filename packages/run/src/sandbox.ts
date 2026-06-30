// src/gem/sandbox.ts
// Pluggable sandbox-backend registry in front of the RunConnectFn seam. Each backend
// produces a RunConnectFn pre-scoped to a run dir. Auto-allow is capability-gated:
// isolated backends run permission:"allow" (the FS boundary bounds blast radius);
// the child-spawn fallback stays deny unless AGENTGEM_GEM_RUN_AUTOALLOW=1.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRunSession } from "./acpRun.js";          // value used at call-time (safe ESM cycle)
import type { RunConnectFn, AgentDescriptor } from "./acpRun.js";
import { wrapWithSandbox, type SandboxKind, type MaskPlaceholders } from "./sandboxLaunch.js";
import { configWriteAccess } from "./configAccess.js";
import { binOnPath } from "@agentgem/model";

export interface SandboxBackend {
  id: string;
  isolated: boolean;
  available(): boolean;
  connectFn(runDir: string): RunConnectFn;
}

export function envPermission(env: NodeJS.ProcessEnv = process.env): "allow" | "deny" {
  return env.AGENTGEM_GEM_RUN_AUTOALLOW === "1" ? "allow" : "deny";
}

// Read-only stand-ins bind-mounted over absent sensitive paths under bubblewrap (which can't
// deny a path that doesn't exist) so the agent can't INJECT into them — write a settings.json
// hook or drop a skill. `file` is an empty-JSON file (a reader like settings.json parses
// cleanly), `dir` an empty directory. (bwrap materializes an inert empty mountpoint for the
// bind, so an absent path may exist afterward, but it stays empty/read-only.) Shared +
// idempotent (inert content), so runs don't accumulate placeholder dirs.
export function ensureMaskPlaceholders(): MaskPlaceholders {
  const base = join(tmpdir(), "agentgem-sandbox-mask");
  const dir = join(base, "empty");
  mkdirSync(dir, { recursive: true });
  const file = join(base, "empty.json");
  writeFileSync(file, "{}");
  return { file, dir };
}

// An isolated backend: wrap the agent command with the OS sandbox launcher (so the
// agent AND its child shells inherit the jail) and auto-allow tool calls. `bin` is the
// launcher resolved on PATH (not a hard-coded absolute path — distros place bwrap in
// /usr/bin or /usr/local/bin), matching the bare name `wrapWithSandbox` actually spawns.
function isolatedBackend(id: string, kind: SandboxKind, bin: string, supported: () => boolean): SandboxBackend {
  return {
    id, isolated: true,
    available: () => supported() && binOnPath(bin),
    connectFn: (runDir) => (descriptor: AgentDescriptor, app) => {
      // The agent runs against its REAL config dir (so Keychain/OAuth auth works); the jail
      // re-allows writes there so its startup state (session-env/transcripts) succeeds, but
      // carves the escalation vectors (hooks/skills/plugins/credentials) back out read-only.
      const { writable, denied } = configWriteAccess();
      // bubblewrap can't deny a not-yet-existing path with a bind, so absent sensitive paths
      // are masked read-only with placeholders; seatbelt denies by path pattern and needs none.
      const masks = kind === "linux-bubblewrap" ? ensureMaskPlaceholders() : undefined;
      return connectRunSession(
        { ...descriptor, command: wrapWithSandbox(kind, runDir, descriptor.command, writable, denied, masks) },
        "allow",
        app,
      );
    },
  };
}

export const childSpawnBackend: SandboxBackend = {
  id: "child-spawn",
  isolated: false,
  available: () => true,
  connectFn: () => (descriptor: AgentDescriptor, app) => connectRunSession(descriptor, envPermission(), app),
};

export const RUN_BACKENDS: SandboxBackend[] = [
  isolatedBackend("macos-seatbelt", "macos-seatbelt", "sandbox-exec", () => process.platform === "darwin"),
  isolatedBackend("linux-bubblewrap", "linux-bubblewrap", "bwrap", () => process.platform === "linux"),
  childSpawnBackend,
];

export function selectRunBackend(
  runDir: string,
  registry: SandboxBackend[] = RUN_BACKENDS,
): { backend: SandboxBackend; connectFn: RunConnectFn } {
  const backend = registry.find((b) => b.isolated && b.available()) ?? registry[registry.length - 1] ?? childSpawnBackend;
  return { backend, connectFn: backend.connectFn(runDir) };
}
