// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/archiveFs.ts
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { FileTree } from "./archive.js";

// Write each relative path under `root`, creating parent dirs. Overwrites existing files.
export function writeArchiveDir(root: string, files: FileTree): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

// Read every file under `root` into a FileTree keyed by POSIX-style relative path.
export function readArchiveDir(root: string): FileTree {
  const files: FileTree = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (d === root && entry.startsWith(".")) continue; // skip .targets/, .git/, etc. (archive files are never dot-prefixed)
      const abs = join(d, entry);
      if (statSync(abs).isDirectory()) walk(abs);
      else files[relative(root, abs).split(sep).join("/")] = readFileSync(abs, "utf8");
    }
  };
  walk(root);
  return files;
}
