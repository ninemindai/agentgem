// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Bump the patch component of a plain "major.minor.patch" version. Versions are opaque plain
// strings here (no semver dependency); this is the only place a next version is computed.
export function bumpPatch(version: string): string {
  const parts = version.split(".");
  while (parts.length < 3) parts.push("0");
  const patch = Number.parseInt(parts[2], 10);
  parts[2] = String((Number.isFinite(patch) ? patch : 0) + 1);
  return parts.slice(0, 3).join(".");
}
