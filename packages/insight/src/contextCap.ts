// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/insight/src/contextCap.ts
//
// Context-window size for a model id. The "pinned" hygiene signal is a fraction
// of this cap, so the number lives in one place — never hardcoded in a detector.
// The 1M window is opt-in and shows up in the id as `[1m]` or `-1m`; everything
// else uses the conservative 200k default.

const ONE_MILLION = 1_000_000;
const DEFAULT_CAP = 200_000;

export function contextCap(model?: string): number {
  if (model && (/\[1m\]/i.test(model) || /-1m\b/i.test(model))) return ONE_MILLION;
  return DEFAULT_CAP;
}
