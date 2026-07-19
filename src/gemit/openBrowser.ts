// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemit/openBrowser.ts
//
// Open a local file in the default browser by shelling out to the OS opener —
// no npm dependency. Mirrors src/pickFolder.ts: a pure, unit-testable command
// builder plus a fire-and-forget execFile wrapper.
import { execFile } from "node:child_process";

export function openCommand(platform: NodeJS.Platform, target: string): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [target] };
  if (platform === "linux") return { cmd: "xdg-open", args: [target] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", target] };
  return null;
}

export function openInBrowser(target: string): void {
  const spec = openCommand(process.platform, target);
  if (!spec) return;
  execFile(spec.cmd, spec.args, { timeout: 10_000 }, () => { /* best-effort */ });
}
