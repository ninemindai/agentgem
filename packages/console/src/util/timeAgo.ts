// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
export function timeAgo(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (s < 30) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
