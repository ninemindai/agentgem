// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/originGuard.ts
// CSRF / drive-by guard for the loopback REST surface.
//
// The server binds 127.0.0.1, but loopback is NOT browser-safe: any web page the user visits can
// issue requests to http://127.0.0.1:<port>. Several endpoints are outward-facing (run a local ACP
// agent, deploy, write files), so a malicious tab must not be able to trigger them. There are no
// cookies/ambient credentials here, so the threat is pure request-forgery (the attacker wants the
// side effect, not the response).
//
// Policy: reject browser-initiated CROSS-site requests; allow the same-origin UI and non-browser
// clients (CLI, curl, MCP, tests send neither Sec-Fetch-Site nor Origin).
// - Sec-Fetch-Site is set by the browser and cannot be forged by page script, so it is the primary
//   signal: "same-origin" is our own UI; "none" is a direct navigation / typed URL. Anything else
//   ("cross-site" / "same-site") is rejected.
// - Origin is the fallback for clients that don't send Sec-Fetch-Site: a present Origin must match
//   the request's Host (true same-origin). A non-browser client sends no Origin at all and is allowed.
//
// req/res are duck-typed (Express shape) so this carries no @types/express dependency, matching the
// raw SSE handlers (workflowStream / gemRunStream).
interface GuardReq { method: string; path: string; get(name: string): string | undefined }
interface GuardRes { status(code: number): GuardRes; type(t: string): GuardRes; send(body: string): unknown; set(name: string, value: string): GuardRes }
type GuardNext = () => void;

// Methods with no side effect — a direct navigation (Sec-Fetch-Site: none) to one of these is benign.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Public, side-effect-free, k-anonymized data reads — designed for cross-origin consumption (the
// marketing site, third-party clients, the console app on another origin). They carry no credentials
// and have no side effect, so the CSRF rationale above does NOT apply: serve them to any origin with
// permissive CORS and exempt them from the cross-site block. Safe methods only — the POST /ingest
// write (and every other route) stays guarded. Also covers the curated-sources reads (list/divisions/
// agents/import) that the marketplace fetches cross-origin — /api/sources/install stays off this list
// because it writes to disk.
const PUBLIC_READ_PATHS = new Set(["/api/aggregator/popularity", "/api/aggregator/co-occurrence", "/api/aggregator/adoption", "/api/aggregator/co-occurrence-matrix", "/api/registry/gems", "/api/aggregator/profile", "/api/aggregator/org-catalog", "/api/aggregator/popular-skills", "/api/aggregator/gem-archive", "/api/aggregator/game-html", "/api/aggregator/effectiveness", "/api/aggregator/gem-adoption", "/api/sources", "/api/sources/divisions", "/api/sources/agents", "/api/sources/import"]);

function block(res: GuardRes): void {
  res.status(403).type("application/json").send(JSON.stringify({ error: "cross-site request blocked" }));
}

export function originGuard(req: GuardReq, res: GuardRes, next: GuardNext): void {
  if (SAFE_METHODS.has(req.method.toUpperCase()) && PUBLIC_READ_PATHS.has(req.path)) {
    res.set("Access-Control-Allow-Origin", "*"); // public, credential-less data — any origin may read it
    if (req.method.toUpperCase() === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.status(204).send(""); // answer the preflight; never dispatch the route
      return;
    }
    next();
    return;
  }
  // Web sign-in (/api/auth/*), stars (/api/stars*), reviews (/api/reviews*), and team usage
  // (/api/usage*) are reachable cross-site by design (SPA on app.agentgem.ai → API on
  // api.agentgem.ai). CSRF defense: the OAuth
  // `state`, the SameSite=Lax cookie, and (stars/reviews/usage) a 401 on the authed routes. The handlers
  // set their own credentialed CORS for the AGENTGEM_WEB_ORIGINS allowlist. (The public review GETs
  // are covered by this prefix too — no PUBLIC_READ_PATHS entry needed, same as stars.) The GitHub
  // App surfaces are covered too: /api/orgs/* is the SPA's member-gated reads (own credentialed CORS
  // + 401/403), and /api/github/* is the webhook (server-to-server HMAC-verified POST, no browser
  // context) plus the setup redirect (a cross-site top-level GET navigation arriving from github.com
  // right after an App install — side-effect-free 302).
  if (req.path.startsWith("/api/auth/") || req.path.startsWith("/api/stars") || req.path.startsWith("/api/reviews") || req.path.startsWith("/api/usage") || req.path.startsWith("/api/orgs/") || req.path.startsWith("/api/github/") || req.path.startsWith("/api/registry/upload-publish")) { next(); return; }
  const site = req.get("sec-fetch-site");
  if (site !== undefined) {
    if (site === "same-origin") { next(); return; }
    // "none" = user-initiated (typed URL, bookmark) — allow only for safe methods. A state-changing
    // POST is never legitimately "none" from our same-origin UI (its fetch() sends same-origin), so
    // requiring same-origin there closes the top-level-navigation/form-POST drive-by.
    if (site === "none" && SAFE_METHODS.has(req.method.toUpperCase())) { next(); return; }
    // A user-clicked top-level navigation (e.g. an "Open in AgentGem" link on the marketplace) arrives
    // cross-site, but only loads a page — benign for a safe method, and the loaded UI's own API calls
    // are then same-origin. Restricted to real top-level document loads (Sec-Fetch-Mode: navigate +
    // Dest: document) on NON-/api paths, so side-effectful loopback GETs — the /api/.../stream run and
    // deploy handlers — stay cross-site-blocked. This does NOT open cross-site fetch/XHR (mode cors/
    // no-cors) or form POSTs (excluded by the safe-method gate).
    if (
      SAFE_METHODS.has(req.method.toUpperCase()) &&
      req.get("sec-fetch-mode") === "navigate" &&
      req.get("sec-fetch-dest") === "document" &&
      !req.path.startsWith("/api/")
    ) { next(); return; }
    block(res);
    return;
  }
  const origin = req.get("origin");
  if (origin === undefined) { next(); return; } // non-browser client: no ambient browser context
  try {
    if (new URL(origin).host === req.get("host")) { next(); return; } // same-origin
  } catch { /* malformed Origin -> fall through to block */ }
  block(res);
}
