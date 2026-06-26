// src/gem/sandboxLaunch.ts
// Pure generators for the OS-native sandbox launchers. The v1 boundary contains
// FILESYSTEM WRITES to the run dir (+ temp); reads, exec, and network stay open. This
// "write-deny" shape (allow-all, then deny writes, then re-allow under runDir) avoids
// the deny-default trap that kills the agent's own runtime before it can start.
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";

// Resolve symlinks when the path exists; fall back to the original string otherwise.
function tryRealpath(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

export type SandboxKind = "macos-seatbelt" | "linux-bubblewrap";

export function seatbeltPolicy(runDir: string, tmpDir: string = tmpdir()): string {
  // Resolve symlinks so the SBPL subpath clause matches the kernel's canonical path.
  // On macOS, tmpdir() returns /var/folders/... but the kernel sees /private/var/folders/...
  // Fall back to the original path if the directory doesn't exist yet.
  const realRun = tryRealpath(runDir);
  const realTmp = tryRealpath(tmpDir);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    `  (subpath ${q(realRun)})`,
    `  (subpath ${q(realTmp)})`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (subpath "/dev/tty") (regex #"^/dev/fd/"))',
  ].join("\n");
}

// SBPL string literal: wrap in double quotes (paths under our control have no quotes).
function q(p: string): string { return `"${p}"`; }

export function bwrapArgs(runDir: string, tmpDir: string = tmpdir()): string[] {
  // Resolve symlinks so the writable bind matches the kernel's canonical path
  // (mirrors seatbeltPolicy); fall back to the original if the dir doesn't exist yet.
  const realRun = tryRealpath(runDir);
  const realTmp = tryRealpath(tmpDir);
  return [
    "--ro-bind", "/", "/",            // everything readable, nothing writable…
    "--bind", realRun, realRun,       // …except the run dir…
    "--bind", realTmp, realTmp,       // …and temp.
    "--dev", "/dev",
    "--unshare-pid",                  // own PID namespace: the agent can't see/signal host processes
    "--proc", "/proc",                // fresh procfs for that namespace (must follow --unshare-pid)
    "--die-with-parent",
  ];
}

export function wrapWithSandbox(kind: SandboxKind, runDir: string, command: string[]): string[] {
  if (kind === "macos-seatbelt") return ["sandbox-exec", "-p", seatbeltPolicy(runDir), ...command];
  return ["bwrap", ...bwrapArgs(runDir), "--", ...command];
}
