// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/appCommon.ts
//
// Extracted from src/index.ts (Task 5, pure move — no behaviour change): the app-building surface
// shared by every entry point (server, and — from Task 6 — the desktop client-mode entry). Split
// into two functions, not one, because the global originGuard middleware MUST register AFTER the
// aggregator's middleware.shareOriginSecret + mountGating's rate limiters (AgentBack orders
// same-group express middlewares by registration order — this is exactly the Task 4 fix, pinned by
// src/__tests__/shareMiddlewareOrder.test.ts). Each entry point calls buildCommonApp(), then mounts
// its own aggregator/benchmark step, then calls finalizeCommonApp() — so the ordering constraint
// holds no matter which entry point is running.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RestApplication, REST_DISPATCH_HOOK_TAG } from "@agentback/rest";
import { installExplorer } from "@agentback/rest-explorer";
import { MCPComponent } from "@agentback/mcp";
import { GemTypesComponent } from "./gem/gemTypeRegistry.js";
import { AgentSourcesComponent } from "./gem/sourceRegistry.js";
import { installMcpHttp } from "@agentback/mcp-http";
import { GemController } from "./gem.controller.js";
import { ReviewController } from "./review.controller.js";
import { DreamController } from "./dream.controller.js";
import { GemTools } from "./gem.tools.js";
import { WorkflowController } from "./workflow.controller.js";
import { GemStreamController } from "./gem.stream.controller.js";
import { ScorecardController } from "./scorecard.stream.controller.js";
import { InsightsController } from "./insights.controller.js";
import { RubricController } from "./rubric.controller.js";
import { streamWatch } from "./watchStream.js";
import { streamWatchEvents } from "./watchEvents.js";
import { streamWatchHygiene } from "./watchHygiene.js";
import { streamWatchDashboard } from "./watchDashboard.js";
import { listActiveSessions } from "./watchSessions.js";
import { registerChatRoutes, makeChatConnectFn, installAgentFn, goldmineMcpServers, resolveChatCwd } from "./goldmine/chatRoutes.js";
import { resolveAllowedProjectRoot } from "./goldmine/projectRoots.js";
import { collectBehaviorFindings } from "./goldmine/behaviorFindings.js";
import { RecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath, serverFunnelDeps } from "./goldmine/recall.js";
import { registerRecallRoutes } from "./goldmine/recallRoutes.js";
import { ChatManager } from "@agentgem/run";
import { miniappDir, studioBrief, checkpointMiniapp } from "@agentgem/play";
import { availableAgents, adapterRuntimeCtx, resolveLaunch, npmAdapterInstaller, createLogger } from "@agentgem/base";
import { collectScorecard, defaultScorecardDeps } from "./gem/scorecard.js";
import { buildGoldmineBrief, type GoldmineBriefInput } from "@agentgem/insight";
import { agentgemHome } from "@agentgem/model";
import { join as pathJoin } from "node:path";
import { mkdirSync } from "node:fs";
import { closeSharedIndex } from "@agentgem/capture";
import { originGuard } from "./originGuard.js";
import { playNoCache } from "./playCache.js";
import { gemNoCache } from "./gemCache.js";
import { getWarmStatus } from "./warm/orchestrator.js";
import { ReportRegistry, REPORT_REGISTRY } from "./report/registry.js";
import { ShareProxyController } from "./share.proxy.controller.js";
import { SourcesController } from "./sources.controller.js";
import { PlayController } from "./play.controller.js";

const serverLog = createLogger("server");

const here = dirname(fileURLToPath(import.meta.url));

// Read a built console asset (index.html, manifest.webmanifest). dist path first,
// then the dev fallback to the console package's own dist. Returns null if absent.
function consoleFile(name: string): string | null {
  for (const p of [
    join(here, "public", "console", name),
    join(here, "..", "packages", "console", "dist", name),
  ]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return null;
}
function consoleHtml(): string {
  return consoleFile("index.html")
    ?? '<!doctype html><div id="root"></div><p>console not built — run pnpm build</p>';
}

// The bind address. Defaults to loopback so local runs stay loopback-only (the
// security model assumes 127.0.0.1); a deploy sets HOST=0.0.0.0 to accept external
// traffic, where originGuard + the public-read allowlist are the real boundary.
export function serverHost(): string {
  return process.env.HOST ?? "127.0.0.1";
}

// Graceful shutdown: orchestrators (k8s / Cloud Run / ECS / Fly) send SIGTERM and
// expect the process to drain in-flight work (and close the pg pool — see mountAggregator)
// then exit within the grace period. Without this, Node exits immediately on SIGTERM,
// dropping connections. Hooks are injectable so it's unit-testable without spawning.
// Moved from index.ts (Task 6, pure move — no behaviour change): both the server and
// the client entry point need this, and client.ts must not import from index.ts.
export function installGracefulShutdown(
  app: { stop: () => Promise<void> },
  opts: {
    on?: (signal: "SIGTERM" | "SIGINT", cb: () => void) => void;
    exit?: (code: number) => void;
    log?: (msg: string) => void;
  } = {},
): void {
  const on = opts.on ?? ((sig, cb) => { process.once(sig, cb); });
  const exit = opts.exit ?? ((code) => process.exit(code));
  const log = opts.log ?? ((msg: string) => serverLog.info("%s", msg));
  let stopping = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (stopping) return; // a second signal mid-drain must not double-stop
    stopping = true;
    log(`agentgem received ${sig}, draining…`);
    try { await app.stop(); exit(0); }
    catch (err) { console.error(err); exit(1); }
  };
  on("SIGTERM", () => void shutdown("SIGTERM"));
  on("SIGINT", () => void shutdown("SIGINT"));
}

// Background cache warming is console-only (never on the hosted API, which does not
// serve one). AGENTGEM_WARM=off disables it independently: the desktop host pays for
// warm in the core process's working set, so it needs a way to turn it off that does
// not also stop the console from being served.
// Moved from index.ts (Task 6, pure move — no behaviour change): see installGracefulShutdown above.
export function warmEnabled(env: Record<string, string | undefined>): boolean {
  return env.SERVE_CONSOLE !== "false" && env.AGENTGEM_WARM !== "off";
}

// The part of app-building that must run BEFORE each entry's aggregator/benchmark step: new
// RestApplication, body-parser config, components, MCPServer config, the common controllers,
// GemTools, dispatch hooks, installExplorer, installMcpHttp, restServer, trust-proxy. Does NOT
// register the global originGuard, /healthz, console-serving, or the SSE routes — see
// finalizeCommonApp below, and the module comment for why the split matters.
export async function buildCommonApp(port: number): Promise<{ app: RestApplication; server: Awaited<RestApplication["restServer"]> }> {
  const app = new RestApplication({});
  // Raise the JSON body limit above express's 100kb default: routes that carry a whole gem
  // archive in the request body (/gem/apply, /materialize with bytesBase64) send base64 that
  // routinely exceeds 100kb. A generous ceiling is safe; originGuard + the public-read allowlist
  // are the real boundary. bodyParser lives on the RestServer config (alongside port/host), not
  // the top-level app config. Host comes from serverHost() so a deploy can bind 0.0.0.0.
  // `verify` captures the raw bytes for the github webhook route only — HMAC verification needs
  // the exact bytes GitHub signed, and re-serializing req.body is not byte-faithful. Passed straight
  // through to express.json (which supports `verify` natively); agentback's bodyParser.json option
  // type doesn't declare it, hence the cast.
  const jsonBodyOptions = {
    limit: "25mb",
    verify: (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
      if (req.url?.startsWith("/api/github/webhook")) req.rawBody = buf;
    },
  } as never;
  app.configure("servers.RestServer").to({ port, host: serverHost(), bodyParser: { json: jsonBodyOptions } });
  app.component(MCPComponent);
  app.component(GemTypesComponent);
  app.component(AgentSourcesComponent);
  app.configure("servers.MCPServer").to({ name: "agentgem", version: "0.1.0", transports: { stdio: false } });
  app.restController(GemController);
  app.restController(RubricController);
  app.restController(ReviewController);
  app.restController(DreamController);
  app.restController(ShareProxyController);
  app.restController(SourcesController);
  app.restController(PlayController);
  app.restController(InsightsController);
  app.restController(WorkflowController);
  app.restController(GemStreamController);
  app.restController(ScorecardController);
  app.service(GemTools);
  // The persistent transcript index (capture) is a separate, lazily-opened on-disk
  // PGlite — not the aggregator DB. Close it on graceful shutdown too, so SIGTERM
  // flushes its WASM instance cleanly instead of leaving it resident until exit
  // (symmetric with the aggregator's registerDrizzle onStop). No-op if never opened.
  app.onStop(async () => { await closeSharedIndex(); });
  // The Play registry reads serve mutable on-disk state; without Cache-Control the browser
  // heuristically caches them off the bare ETag and the Studio renders a stale miniapp. A dispatch
  // hook keys on the matched route rather than a path string, and writes through the neutral
  // responseHeaders collector so it holds on the Web/edge pipeline too. Bound before start(): the
  // hook list is resolved once, on the first dispatched request, and cached.
  app.bind("hooks.playNoCache").to(playNoCache).tag(REST_DISPATCH_HOOK_TAG);
  // hooks.gameHtmlCache (the arcade's sealed-game read cache) is aggregator-specific — bound by
  // mountAggregator (serverAggregator.ts), not here, since it keys on AggregatorController, which
  // the desktop client entry never mounts. See arcadeCache.ts's module comment.
  // The inventory reads serve mutable local state (installing a skill changes them); without
  // Cache-Control the browser heuristically caches them off the bare ETag. Same rationale and
  // mechanism as hooks.playNoCache above.
  app.bind("hooks.gemNoCache").to(gemNoCache).tag(REST_DISPATCH_HOOK_TAG);
  await installExplorer(app, { title: "agentgem API" });
  await installMcpHttp(app);
  const server = await app.restServer;
  // Behind a proxy/LB, req.ip is the proxy's address unless we trust the forwarding header.
  // Off by default (loopback dev). Deploys set TRUST_PROXY to the hop count (e.g. "1"), a
  // boolean, or a subnet string — see Express "trust proxy". Trusting all proxies blindly
  // lets clients spoof X-Forwarded-For, so this is opt-in via env, not "true" by default.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    const n = Number(trustProxy);
    server.expressApp.set("trust proxy", Number.isFinite(n) ? n : trustProxy);
  }
  return { app, server };
}

// The part of app-building that must run AFTER each entry's aggregator/benchmark step: the global
// originGuard middleware, /healthz, console-serving, and the raw SSE routes (each keeping its
// per-route originGuard arg — these are registered directly on expressApp, outside the controller
// dispatch chain). See the module comment for why this can't fold into buildCommonApp.
export function finalizeCommonApp(app: RestApplication, server: Awaited<RestApplication["restServer"]>): void {
  // CSRF / drive-by guard: reject browser-initiated cross-site requests to the loopback API
  // (controller routes). Same-origin UI and non-browser clients (CLI/MCP/tests) pass. Mounted in
  // the framework middleware chain so it runs before controller dispatch. Registered AFTER
  // mountAggregator (not before, as its own internal middleware.shareOriginSecret + mountGating's
  // rate limiters must run first — same-group express middleware order is registration order, and
  // that ordering is what proves CF origin / rate-limits the anonymous share-create route before
  // originGuard would otherwise short-circuit it with its own, less specific, 403).
  app.expressMiddleware("middleware.originGuard", originGuard);
  // The React console (`dist/public/console`) is the UI, served at `/` (and `/console`).
  // It replaced the original vanilla UI, now removed (history in git). The gem-transfer
  // feature's backend (/api/transfer/*) ships, but its web redeem UI is not yet ported to
  // the console — use the `agentgem receive` CLI until then.
  // Liveness probe for deploy orchestrators (Cloud Run / ECS / Fly / k8s). Unauthenticated
  // and origin-less by design — registered as a raw route, so it's outside originGuard.
  server.expressApp.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // The desktop console UI is served at `/` (and `/console`) for LOCAL runs only. The hosted
  // public deployment (api.agentgem.ai) is API-only — the console is a local desktop app, not a
  // public surface — so SERVE_CONSOLE=false disables it there and redirects `/` to the site.
  if (process.env.SERVE_CONSOLE !== "false") {
    const consolePage = consoleHtml();
    server.expressApp.get("/", (_req, res) => res.type("html").send(consolePage));
    server.expressApp.get("/console", (_req, res) => res.type("html").send(consolePage));
    // The PWA manifest, so Chromium offers "Install app". Local-only (same guard as
    // the console itself); skipped if the build hasn't produced it yet.
    const manifest = consoleFile("manifest.webmanifest");
    if (manifest) {
      server.expressApp.get("/manifest.webmanifest", (_req, res) =>
        res.type("application/manifest+json").send(manifest));
    }
  } else {
    server.expressApp.get("/", (_req, res) => res.redirect(302, "https://agentgem.ai"));
  }
  // SSE progress stream for workflow analysis (raw Express — the decorator
  // framework only returns single JSON bodies). The POST /api/workflow/analyze
  // route stays for programmatic/test callers. originGuard is applied per-route because these raw
  // routes are registered directly on expressApp, outside the controller dispatch chain.
  // Read-only warm cache status. Outside any foreground gate — cheap metadata only.
  server.expressApp.get("/api/warm/status", originGuard, (_req, res) => res.json(getWarmStatus() as never));
  // Report activity registry: the three agent-backed report routes record their
  // run lifecycle here so the console can notify-on-done and show what is running.
  // In-memory; swept for TTL. The compute + cache are untouched — this only tracks.
  const reportRegistry = new ReportRegistry();
  // Share this instance with the decorator-dispatched InsightsController (bound
  // before any request, so its optional @inject resolves the same registry the
  // analyze/rubric routes and /api/report/runs use).
  app.bind(REPORT_REGISTRY).to(reportRegistry);
  setInterval(() => reportRegistry.sweep(), 60_000).unref();
  server.expressApp.get("/api/report/runs", originGuard, (_req, res) => res.json({ runs: reportRegistry.list() } as never));
  // Foreground gate: mark user-facing LLM computes so background warming yields.
  // The workflow-analysis SSE report is now a `streamOf:` route on the decorator
  // dispatch — see WorkflowController, registered above. Like InsightsController it
  // keeps the foreground guard internally and drives the same reportRegistry (kind
  // "analyze") via its injected ReportRegistry, so /api/report/runs + console
  // reattach are unchanged.
  // SSE progress stream for running a Gem with a local ACP agent (materialize →
  // run → tool/token deltas → done). POST /api/gem/run stays for programmatic callers.
  // The gem run + cross-agent verify SSE reports are now `streamOf:` routes on the
  // decorator dispatch — see GemStreamController (run/verify), registered above.
  // The POST prepare steps stay in gem.controller.ts for the id handshake.
  // SSE scorecard scan: per-project progress with live-climbing counts, then the
  // The scorecard SSE scan is now a `streamOf:` route on the decorator dispatch —
  // see ScorecardController, registered above.
  // SSE personal session-insights report (scan transcripts → judge each session
  // with the ACP agent → synthesize) is now a `streamOf:` route on the decorator
  // dispatch — see InsightsController, registered above. It keeps the foreground
  // guard internally and drives the same reportRegistry (bound below) via its
  // injected ReportRegistry, so /api/report/runs + console reattach are unchanged.
  // The rubric-evaluation SSE report is now a `streamOf:` route on the decorator
  // dispatch — see RubricController.stream, registered above. Like the insights
  // and workflow routes it keeps the foreground guard internally and drives the
  // same reportRegistry (kind "rubric") via its injected ReportRegistry.
  // Watch tab: live-preview HTML artifacts a regular coding session builds. List the
  // recently-active transcripts, then SSE-stream one session's HTML file snapshots
  // (redacted, sandbox-ready) as it writes/edits them. Read-only, metadata + scrubbed
  // content only; the ?file= path is pinned to a transcript root by resolveTranscriptFile.
  server.expressApp.get("/api/watch/sessions", originGuard, (_req, res) =>
    res.json({ sessions: listActiveSessions() } as never));
  server.expressApp.get("/api/watch/stream", originGuard, (req, res) => streamWatch(req as never, res as never));
  // Flavor A live feed: SSE-stream the same session's ordered SessionEvents (messages,
  // tool_calls, tool_results) as it runs — the data layer for a CopilotKit-style feed.
  server.expressApp.get("/api/watch/events", originGuard, (req, res) => streamWatchEvents(req as never, res as never));
  // Live context-hygiene nudge: SSE-stream a #161 hygiene snapshot + nudge for one
  // watched Claude session as its transcript grows (Watch tab anti-doomscroll feed).
  server.expressApp.get("/api/watch/hygiene", originGuard, (req, res) => streamWatchHygiene(req as never, res as never));
  // Flavor B: SSE-stream a living HTML dashboard the ACP agent evolves in place,
  // debounced to one render per work-burst.
  server.expressApp.get("/api/watch/dashboard", originGuard, (req, res) => streamWatchDashboard(req as never, res as never));
  // Goldmine chat: REST + SSE endpoints for multi-turn agent chat grounded in the
  // user's session goldmine. One ChatManager per server process; idle sessions are
  // swept every 60 s. The neutral cwd for each chat session is a stable directory
  // under agentgemHome so the agent doesn't write transcripts into any project.
  {
    const chatCwd = pathJoin(agentgemHome(), ".agentgem", "chat");
    try { mkdirSync(chatCwd, { recursive: true }); } catch { /* already exists */ }
    // Allow-list of honorable project roots = discovered ∪ recent, canonicalized.
    // Shared with the goldmine MCP server so both validate roots identically.
    const resolveProjectCwd = resolveAllowedProjectRoot;
    const adapterCtx = adapterRuntimeCtx();
    const chatConnect = makeChatConnectFn((d) => resolveLaunch(d, adapterCtx) ?? d);
    const chatManager = new ChatManager({
      connectFn: async (descriptor, connectOpts) => {
        const conn = await chatConnect(descriptor, connectOpts);  // pass through the per-session permission
        // Wrap open() to inject the server-derived neutral cwd regardless of what
        // ChatManager passes — ensures request input can never redirect the agent.
        return {
          ctx: {
            // Studio sessions may adopt their miniapp's registry dir; a project session may adopt an
            // allow-listed project root; resolveChatCwd re-validates both server-side, so a raw request
            // path can never redirect here.
            open: (cwd: string, opts?: { mcpServers?: unknown[] }) =>
              conn.ctx.open(resolveChatCwd(cwd, chatCwd, resolveProjectCwd), opts),
          },
          close: conn.close,
        };
      },
    });
    setInterval(() => chatManager.sweepIdle(), 60_000).unref();
    registerChatRoutes(server.expressApp as never, {
      manager: chatManager,
      resolveStudio: (miniapp: string) => ({ cwd: miniappDir(miniapp), brief: studioBrief(miniapp) }),
      resolveProjectCwd,
      neutralCwd: chatCwd,
      listAgents: () => availableAgents(adapterCtx),
      installAgent: installAgentFn(adapterCtx, npmAdapterInstaller()),
      checkpointMiniapp: (name: string) => checkpointMiniapp(name),
      buildBrief: async () => {
        // Best-effort: never throws. Falls back to minimal brief on any error.
        try {
          const sc = collectScorecard(undefined, undefined, Date.now(), { deps: defaultScorecardDeps });
          const topArtifacts: GoldmineBriefInput["topArtifacts"] = [];
          for (const proj of sc.projects) {
            for (const wf of proj.workflows.slice(0, 3)) {
              topArtifacts.push({ type: "workflow", name: wf.name, invocations: wf.confidence === "high" ? 10 : wf.confidence === "medium" ? 5 : 1 });
            }
          }
          const behavior = collectBehaviorFindings();
          return buildGoldmineBrief({
            scorecard: { breadth: sc.breadth, battleTested: sc.battleTested, portable: sc.portable, gaps: sc.gaps },
            topArtifacts: topArtifacts.slice(0, 10),
            skillCount: sc.projects.reduce((n, p) => n + p.workflows.length, 0),
            ...(behavior.summary.length > 0
              ? { behavior: { patterns: behavior.summary.length, topTitle: behavior.summary[0].title } }
              : {}),
          });
        } catch (err) {
          serverLog.warn("[chat] buildBrief degraded: %s", (err as Error)?.message ?? err);
          return buildGoldmineBrief({ scorecard: { breadth: 0, battleTested: 0, portable: 0, gaps: [] }, topArtifacts: [], skillCount: 0 });
        }
      },
      goldmineMcp: goldmineMcpServers,
    }, originGuard as never);
  }
  // Goldmine Recall: /api/recall/* — instant BM25 search over the on-disk index plus the
  // capped ask_session fan-out (search/run/stream/cancel/status). One read-handle RecallIndex
  // per server process; the `recall` warmable (src/warm) is the sole writer, so this handle
  // only ever reads. Closed on graceful shutdown, symmetric with closeSharedIndex above.
  {
    const recallIndex = new RecallIndex(defaultRecallDbPath());
    app.onStop(() => { try { recallIndex.close(); } catch { /* ignore */ } });
    registerRecallRoutes(server.expressApp as never, {
      readIndex: recallIndex,
      funnelDeps: serverFunnelDeps(),
      indexStatus: () => {
        const n = recallIndex.indexedSessions().size;
        return { ready: true, indexed: n, total: n, facets: recallIndex.facets() };
      },
    }, originGuard as never);
  }
}
