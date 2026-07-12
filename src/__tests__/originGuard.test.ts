// src/__tests__/originGuard.test.ts
import { describe, it, expect } from "vitest";
import { originGuard } from "../originGuard.js";

// Drive originGuard with a duck-typed req/res and report what it did: called next(), set a header,
// or sent a status. `blocked` keeps its old meaning (a 403 was sent) for the existing cases.
function run(
  headers: Record<string, string | undefined>,
  host = "127.0.0.1:4317",
  method = "POST",
  path = "/api/gem",
) {
  let nexted = false, status = 0, sent = false;
  const set: Record<string, string> = {};
  const req = { method, path, get: (n: string) => (n.toLowerCase() === "host" ? host : headers[n.toLowerCase()]) };
  const res = {
    status(c: number) { status = c; return res; },
    type() { return res; },
    send() { sent = true; return res; },
    set(k: string, v: string) { set[k.toLowerCase()] = v; return res; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  originGuard(req as any, res as any, () => { nexted = true; });
  return { nexted, status, sent, set, blocked: sent && status === 403 };
}

describe("originGuard (CSRF / drive-by guard)", () => {
  it("allows same-origin browser requests (Sec-Fetch-Site: same-origin)", () => {
    expect(run({ "sec-fetch-site": "same-origin" }).nexted).toBe(true);
  });
  it("allows a direct navigation GET (Sec-Fetch-Site: none, safe method)", () => {
    expect(run({ "sec-fetch-site": "none" }, "127.0.0.1:4317", "GET").nexted).toBe(true);
  });
  it("blocks a state-changing POST claiming Sec-Fetch-Site: none (form/navigation drive-by)", () => {
    const r = run({ "sec-fetch-site": "none" }, "127.0.0.1:4317", "POST");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("blocks cross-site browser requests (Sec-Fetch-Site: cross-site)", () => {
    const r = run({ "sec-fetch-site": "cross-site" });
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("blocks same-site-but-cross-origin requests (Sec-Fetch-Site: same-site)", () => {
    expect(run({ "sec-fetch-site": "same-site" }).blocked).toBe(true);
  });
  it("allows non-browser clients (no Sec-Fetch-Site, no Origin) — CLI/curl/MCP/tests", () => {
    expect(run({}).nexted).toBe(true);
  });
  it("allows an Origin matching the Host (fallback for browsers without Sec-Fetch-Site)", () => {
    expect(run({ origin: "http://127.0.0.1:4317" }, "127.0.0.1:4317").nexted).toBe(true);
  });
  it("blocks an Origin that does not match the Host", () => {
    const r = run({ origin: "http://evil.example" }, "127.0.0.1:4317");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("allows cross-site web sign-in requests (/api/auth/*) — better-auth's own OAuth nav + the SPA's credentialed XHR", () => {
    // The real sign-in flow is cross-site: clicking "Sign in" on app.agentgem.ai navigates to
    // api.agentgem.ai/api/auth/sign-in/social (Sec-Fetch-Site: cross-site), GitHub redirects to
    // the callback (cross-site), and get-session/sign-out are credentialed XHR. originGuard must
    // not block these. (Plan 1b-Task 5: better-auth is mounted at this real /api/auth prefix, not
    // the Plan 1a temporary /api/betterauth one.)
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/auth/sign-in/social").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/auth/callback/github").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/auth/get-session").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/auth/sign-out").nexted).toBe(true);
  });
  it("still blocks a cross-site request to a NON-auth API path", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/gem").blocked).toBe(true);
  });
  it("allows the cross-site owner-unpublish DELETE (/api/catalog/*) — credentialed, owner-gated server-side", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "DELETE", "/api/catalog/gem");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
  });
  it("allows cross-site star requests (/api/stars + /api/stars/toggle) — public counts + the SPA's credentialed toggle", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/stars").nexted).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/stars/toggle").nexted).toBe(true);
  });
  it("exempts a cross-site POST /api/registry/upload-publish (credentialed publish)", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/registry/upload-publish");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
  });
  it("allows the cross-site handle-claim POST (/api/handle) — credentialed, own CORS + 401 gate", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/handle");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
  });
  // Finding 4 (5b review): the exemption used to be a startsWith prefix match, which also (wrongly)
  // covered a sibling route like /api/handles or /api/handle/foo. /api/handle is a single leaf
  // endpoint with no sub-paths, so it's now an exact match — a future sibling route must not
  // silently inherit the cross-site exemption.
  it("does NOT exempt a path that merely starts with /api/handle (tightened to an exact match)", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/handles");
    expect(r.blocked).toBe(true);
  });
  it("blocks a malformed Origin", () => {
    expect(run({ origin: "not a url" }).blocked).toBe(true);
  });

  // The arcade's play beacon: app.agentgem.ai → api.agentgem.ai, no login, no cookie. It is the one
  // exempted WRITE, so the exemption must be exact-path and must not widen to its neighbours.
  it("allows the cross-site play beacon (POST /api/aggregator/game-play) with wildcard CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/aggregator/game-play");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("answers the play beacon's preflight without dispatching the route", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "OPTIONS", "/api/aggregator/game-play");
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(204);
    expect(r.set["access-control-allow-methods"]).toContain("POST");
    expect(r.set["access-control-allow-headers"]).toContain("content-type");
  });
  it("serves the play counts cross-origin (GET /api/aggregator/game-plays) — the arcade cards read it", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/game-plays");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("does not let the play-beacon exemption widen to other methods or aggregator writes", () => {
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "DELETE", "/api/aggregator/game-play").blocked).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/aggregator/ingest").blocked).toBe(true);
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "POST", "/api/aggregator/sweep").blocked).toBe(true);
  });

  // "Open in AgentGem" (marketplace → local console): clicking the link is a cross-site top-level
  // document navigation. Loading the SPA is side-effect-free and its own API calls are then
  // same-origin, so allow the navigation — but ONLY a real document navigation on a non-/api path.
  const NAV = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  it("allows a cross-site top-level page navigation to the console UI", () => {
    const r = run(NAV, "127.0.0.1:4317", "GET", "/");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
  });
  it("still blocks a cross-site navigation to an /api path (side-effectful SSE run/deploy GETs)", () => {
    expect(run(NAV, "127.0.0.1:4317", "GET", "/api/gem/run/stream").blocked).toBe(true);
  });
  it("still blocks a cross-site fetch/XHR to the UI (mode cors is not a top-level navigation)", () => {
    const r = run({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }, "127.0.0.1:4317", "GET", "/");
    expect(r.blocked).toBe(true);
  });
  it("still blocks a cross-site navigation with a state-changing POST (form drive-by)", () => {
    expect(run(NAV, "127.0.0.1:4317", "POST", "/api/gem").blocked).toBe(true);
  });
});

describe("originGuard — public aggregator reads (CORS + cross-site exemption)", () => {
  const POP = "/api/aggregator/popularity";
  const CO = "/api/aggregator/co-occurrence";

  it("allows a cross-site GET to popularity and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", POP);
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("allows a cross-site GET to co-occurrence and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", CO);
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("allows a cross-site GET to the public gem-archive download and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/gem-archive");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("allows a cross-site GET to adoption and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/adoption");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("answers an OPTIONS preflight to a public read with 204 + CORS, without dispatching the route", () => {
    const r = run({ "sec-fetch-site": "cross-site", "access-control-request-method": "GET" }, "agg.example", "OPTIONS", POP);
    expect(r.status).toBe(204);
    expect(r.set["access-control-allow-origin"]).toBe("*");
    expect(r.set["access-control-allow-methods"]).toContain("GET");
    expect(r.nexted).toBe(false); // short-circuits; never reaches the controller
  });
  it("does NOT exempt a protected read — cross-site GET to /api/inventory is still blocked, no CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "127.0.0.1:4317", "GET", "/api/inventory");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
    expect(r.set["access-control-allow-origin"]).toBeUndefined();
  });
  it("does NOT exempt the ingest write — cross-site POST to /api/aggregator/ingest stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/aggregator/ingest");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });
  it("does NOT exempt a POST to a public-read path (only safe methods are public)", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", POP);
    expect(r.blocked).toBe(true);
  });
  it("still serves the public read to a same-origin caller", () => {
    const r = run({ "sec-fetch-site": "same-origin" }, "agg.example", "GET", POP);
    expect(r.nexted).toBe(true);
  });
  it("allows a cross-site GET to co-occurrence-matrix and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/co-occurrence-matrix");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
  it("does NOT exempt the bind write — cross-site POST to /api/aggregator/bind stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/aggregator/bind");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });

  it("allows a cross-site GET to the public gem catalog and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/registry/gems");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("allows a cross-site GET to profile and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/profile");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  // Regression: these three public aggregator reads are fetched cross-origin by the marketplace SPA
  // (app.agentgem.ai -> api.agentgem.ai) but were missing from PUBLIC_READ_PATHS, so the guard blocked
  // them with no CORS header -> the browser reported "Failed to fetch". game-html is the one that broke
  // the /minigames arcade ("preview unavailable" on every card); effectiveness + gem-adoption feed the
  // gem detail/benchmark panels.
  it("allows a cross-site GET to game-html and sets permissive CORS (the /minigames arcade)", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/game-html");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("serves game-meta cross-origin: the Play page fetches it from app.agentgem.ai", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/game-meta");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("answers the game-meta preflight without dispatching the route", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "OPTIONS", "/api/aggregator/game-meta");
    expect(r.status).toBe(204);
    expect(r.nexted).toBe(false);
  });

  it("allows a cross-site GET to effectiveness and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/effectiveness");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("allows a cross-site GET to gem-adoption and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/aggregator/gem-adoption");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("allows a cross-site GET to /api/aggregator/org-catalog and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/org-catalog");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("allows a cross-site GET to /api/sources and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/sources");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("allows a cross-site GET to /api/sources/import and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/sources/import");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("does NOT exempt the install write — cross-site POST to /api/sources/install stays guarded", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "POST", "/api/sources/install");
    expect(r.blocked).toBe(true);
    expect(r.status).toBe(403);
  });

  it("allows a cross-site GET to /api/aggregator/popular-skills and sets permissive CORS", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "GET", "/api/aggregator/popular-skills");
    expect(r.nexted).toBe(true);
    expect(r.blocked).toBe(false);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });

  it("answers an OPTIONS preflight to popular-skills with 204 + CORS, without dispatching the route", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "agg.example", "OPTIONS", "/api/aggregator/popular-skills");
    expect(r.status).toBe(204);
    expect(r.set["access-control-allow-origin"]).toBe("*");
    expect(r.nexted).toBe(false);
  });

  it("exempts the orgs endpoints and the github webhook (cross-site SPA reads + server-to-server POST)", () => {
    for (const path of ["/api/orgs/app", "/api/orgs/skills", "/api/orgs/skill-body"]) {
      expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "GET", path).nexted).toBe(true);
    }
    expect(run({ "sec-fetch-site": "cross-site" }, "app.agentgem.ai", "POST", "/api/github/webhook").nexted).toBe(true);
    // The post-install Setup URL is a top-level navigation arriving FROM github.com.
    expect(run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/api/github/setup").nexted).toBe(true);
  });

  // OG card image: headless-browser link-unfurl previewers (Slack, Discord, iMessage) send
  // Sec-Fetch-Site: cross-site with no cookies, so it needs the same public-read CORS treatment
  // as the other credential-less GETs above.
  it("allows a cross-site GET of /og/card.png with a wildcard CORS header", () => {
    const r = run({ "sec-fetch-site": "cross-site" }, "api.agentgem.ai", "GET", "/og/card.png");
    expect(r.nexted).toBe(true);
    expect(r.set["access-control-allow-origin"]).toBe("*");
  });
});
