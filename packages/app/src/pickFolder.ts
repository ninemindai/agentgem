// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/pickFolder.ts
// Pop the OS-native folder chooser (agentgem runs locally, so the dialog appears on the
// user's own screen) and return the chosen absolute path. The user explicitly selects the
// folder — there is no server-side directory enumeration to scope or harden.
import { execFile } from "node:child_process";
import { platform } from "node:os";

// Separated from the exec so it can be unit-tested without popping a dialog.
export function pickFolderCommand(plat: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (plat === "darwin")
    return { cmd: "osascript", args: ["-e", 'POSIX path of (choose folder with prompt "Choose project root")'] };
  if (plat === "linux")
    return { cmd: "zenity", args: ["--file-selection", "--directory", "--title=Choose project root"] };
  if (plat === "win32")
    return {
      cmd: "powershell",
      args: [
        "-NoProfile",
        "-Command",
        "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){ $f.SelectedPath }",
      ],
    };
  return null;
}

export function pickFolder(): Promise<string | null> {
  const spec = pickFolderCommand(platform());
  if (!spec) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(spec.cmd, spec.args, { timeout: 180000 }, (err, stdout) => {
      if (err) return resolve(null); // cancelled, or the dialog tool is unavailable
      const p = (stdout || "").trim();
      resolve(p || null);
    });
  });
}
