// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// Pure parsing for the agentgem:// deep-link protocol, kept out of the electron-coupled main.ts so
// it is unit-tested. A web "Open in AgentGem" link (agentgem://get-gems?q=<gemKey>) maps to the
// console hash route the window navigates to; the wiring (protocol registration, open-url /
// second-instance events, focusing the window) lives in main.ts.

export const DEEP_LINK_SCHEME = "agentgem";

// Routes we accept from the web. Kept as an explicit allowlist so a crafted agentgem:// URL can only
// reach panels we've vetted, never an arbitrary console hash.
const ROUTES = new Set(["get-gems", "play"]);

// agentgem://<route>?<query>  →  "#/<route>?<query>". Returns null for anything we don't route
// (wrong scheme, unknown route, malformed URL) so the caller can ignore it safely.
export function deepLinkHash(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== `${DEEP_LINK_SCHEME}:`) return null;
  // The route is the URL authority (agentgem://get-gems → host "get-gems"); fall back to the first
  // path segment for platforms/parsers that place it there instead.
  const route = (u.hostname || u.pathname.replace(/^\/+/, "").split("/")[0] || "").toLowerCase();
  if (!ROUTES.has(route)) return null;
  // Forward the WHOLE query verbatim so every param the marketplace sends survives — q=<key> (pre-
  // searched browse) AND install=<key>&v=<version> (zero-config install, which the GetGems panel
  // consumes). Previously only q was forwarded, silently dropping the install key so an installable
  // gem never auto-installed from "Open in AgentGem".
  const qs = u.searchParams.toString();
  return qs ? `#/${route}?${qs}` : `#/${route}`;
}

// Windows/Linux deliver the deep link as a launch argument rather than an event; pick it out of argv.
export function argvDeepLink(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}
