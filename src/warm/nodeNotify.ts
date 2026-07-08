// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/warm/nodeNotify.ts
//
// Node-side OS notification for the warm daemon (the browser osNotify in
// packages/console is unreachable from this plain-node process). Shells out to
// osascript (macOS) / notify-send (Linux) via argv arrays — no shell, so no
// injection. Other platforms no-op. Never throws: a missing binary or spawn
// error is logged and swallowed, matching the daemon's best-effort paths.
import { execFile } from "node:child_process";
import { createLogger } from "@agentgem/base";

const log = createLogger("warm");

export type NotifyExec = (cmd: string, args: string[]) => void;

const defaultExec: NotifyExec = (cmd, args) => {
  try { execFile(cmd, args, () => { /* fire-and-forget; ignore result/err */ }); }
  catch (err) { log.warn("nodeNotify exec failed: %s", (err as Error)?.message ?? err); }
};

// Strip control chars + newlines and cap length — the strings are agent-authored
// advice + a scrubbed basename, but sanitize defensively.
const clean = (s: string) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
// AppleScript double-quoted string literal.
const asStr = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function nodeNotify(title: string, body: string, exec: NotifyExec = defaultExec, platform: NodeJS.Platform = process.platform): void {
  const t = clean(title), b = clean(body);
  try {
    if (platform === "darwin") exec("osascript", ["-e", `display notification ${asStr(b)} with title ${asStr(t)}`]);
    else if (platform === "linux") exec("notify-send", ["--", t, b]);
    // other platforms: no-op
  } catch (err) {
    log.warn("nodeNotify failed: %s", (err as Error)?.message ?? err);
  }
}
