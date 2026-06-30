// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/binPath.ts
// Leaf helper: is `binName` resolvable on the current PATH? Shared by the adapter
// resolver (runGem) and the sandbox backend availability checks (sandbox), so neither
// hard-codes an absolute install path for a tool that distros place in different dirs.
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export function binOnPath(binName: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, binName)));
}
