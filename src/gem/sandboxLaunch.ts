// src/gem/sandboxLaunch.ts
// Pure generators for the OS-native sandbox launchers. The v1 boundary contains
// FILESYSTEM WRITES to the run dir (+ temp); reads, exec, and network stay open. This
// "write-deny" shape (allow-all, then deny writes, then re-allow under runDir) avoids
// the deny-default trap that kills the agent's own runtime before it can start.
import { tmpdir } from "node:os";

export type SandboxKind = "macos-seatbelt" | "linux-bubblewrap";

export function seatbeltPolicy(runDir: string, tmpDir: string = tmpdir()): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    `  (subpath ${q(runDir)})`,
    `  (subpath ${q(tmpDir)})`,
    '  (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (subpath "/dev/tty") (regex #"^/dev/fd/"))',
  ].join("\n");
}

// SBPL string literal: wrap in double quotes (paths under our control have no quotes).
function q(p: string): string { return `"${p}"`; }

export function bwrapArgs(runDir: string, tmpDir: string = tmpdir()): string[] {
  return [
    "--ro-bind", "/", "/",        // everything readable, nothing writable…
    "--bind", runDir, runDir,     // …except the run dir…
    "--bind", tmpDir, tmpDir,     // …and temp.
    "--dev", "/dev",
    "--proc", "/proc",
    "--die-with-parent",
  ];
}

export function wrapWithSandbox(kind: SandboxKind, runDir: string, command: string[]): string[] {
  if (kind === "macos-seatbelt") return ["sandbox-exec", "-p", seatbeltPolicy(runDir), ...command];
  return ["bwrap", ...bwrapArgs(runDir), "--", ...command];
}
