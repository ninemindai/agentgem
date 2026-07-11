// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Durable per-miniapp share state: the aggregator shareId minted for a miniapp, so the console can
// show + revoke a link across restarts. A sidecar `share.json` beside meta.json — deliberately NOT in
// MiniappMeta, which writeGameGem bakes into the shared gem and saveMiniapp reconstructs field-by-field.
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { miniappDir } from "./miniapps.js";

export interface MiniappShare { shareId: string; url: string; sharedAtMs: number }

const sharePath = (name: string): string => join(miniappDir(name), "share.json");

export function readMiniappShare(name: string): MiniappShare | null {
  const p = sharePath(name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as MiniappShare; } catch { return null; }
}

export function writeMiniappShare(name: string, share: MiniappShare): void {
  writeFileSync(sharePath(name), JSON.stringify(share, null, 2));
}

export function clearMiniappShare(name: string): void {
  rmSync(sharePath(name), { force: true });
}
