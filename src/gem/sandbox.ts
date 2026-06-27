// src/gem/sandbox.ts
// Pluggable sandbox-backend registry in front of the RunConnectFn seam. Each backend
// produces a RunConnectFn pre-scoped to a run dir. Auto-allow is capability-gated:
// isolated backends run permission:"allow" (the FS boundary bounds blast radius);
// the child-spawn fallback stays deny unless AGENTGEM_GEM_RUN_AUTOALLOW=1.
import { connectRunSession } from "./acpRun.js";          // value used at call-time (safe ESM cycle)
import type { RunConnectFn, AgentDescriptor } from "./acpRun.js";
import { wrapWithSandbox, type SandboxKind } from "./sandboxLaunch.js";
import { configWriteAccess } from "./configAccess.js";
import { binOnPath } from "./binPath.js";

export interface SandboxBackend {
  id: string;
  isolated: boolean;
  available(): boolean;
  connectFn(runDir: string): RunConnectFn;
}

export function envPermission(env: NodeJS.ProcessEnv = process.env): "allow" | "deny" {
  return env.AGENTGEM_GEM_RUN_AUTOALLOW === "1" ? "allow" : "deny";
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
      return connectRunSession(
        { ...descriptor, command: wrapWithSandbox(kind, runDir, descriptor.command, writable, denied) },
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
