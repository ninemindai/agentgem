// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Pure parsing for the agentgem:// deep-link protocol, kept out of the electron-coupled main.ts so
// it is unit-tested. A web "Open in AgentGem" link (agentgem://get-gems?q=<gemKey>) maps to the
// console hash route the window navigates to; the wiring (protocol registration, open-url /
// second-instance events, focusing the window) lives in main.ts.

export const DEEP_LINK_SCHEME = "agentgem";

// agentgem://get-gems?q=<gemKey>  →  "#/get-gems?q=<encoded>". Returns null for anything we don't
// route (wrong scheme, unknown route, malformed URL) so the caller can ignore it safely. Only
// get-gems is accepted today; add routes here as more deep links are introduced.
export function deepLinkHash(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // The route is the URL authority (agentgem://get-gems → host "get-gems"); fall back to the first
  // path segment for platforms/parsers that place it there instead.
  const route = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (route !== "get-gems") return null;
  const q = u.searchParams.get("q");
  return q ? `#/get-gems?q=${encodeURIComponent(q)}` : "#/get-gems";
}

// Windows/Linux deliver the deep link as a launch argument rather than an event; pick it out of argv.
export function argvDeepLink(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
