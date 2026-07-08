// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/index.ts
import { config as loadEnv } from "dotenv";
import { credentialsEnvPath, closeSharedIndex } from "@agentgem/capture";
// Load env before anything reads it: cwd .env (a dev override) layered over the
// persisted server credentials in ~/.agentgem/.env. `override` defaults to false,
// so a value already set in the cwd .env wins. `quiet` silences dotenv's banner/
// tips so the `agentgem` CLI output stays clean.
loadEnv({ quiet: true });
loadEnv({ path: credentialsEnvPath(), quiet: true });
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isMain } from "@agentback/core";
import { RestApplication } from "@agentback/rest";
import { installExplorer } from "@agentback/rest-explorer";
import { MCPComponent } from "@agentback/mcp";
import { GemTypesComponent } from "./gem/gemTypeRegistry.js";
import { AgentSourcesComponent } from "./gem/sourceRegistry.js";
import { installMcpHttp } from "@agentback/mcp-http";
import { GemController } from "./gem.controller.js";
import { DreamController } from "./dream.controller.js";
import { GemTools } from "./gem.tools.js";
import { streamWorkflowAnalyze } from "./workflowStream.js";
import { streamGemRun } from "./gemRunStream.js";
import { streamGemVerify } from "./gemVerifyStream.js";
import { streamScorecard } from "./scorecardStream.js";
import { streamInsights } from "./insightsStream.js";
import { streamRubric } from "./rubricStream.js";
import { listRubricsWithMeta, validateRubricInput, saveRubric, deleteRubric } from "./rubricCore.js";
import { streamWatch } from "./watchStream.js";
import { streamWatchEvents } from "./watchEvents.js";
import { streamWatchHygiene } from "./watchHygiene.js";
import { streamWatchDashboard } from "./watchDashboard.js";
import { listActiveSessions } from "./watchSessions.js";
import { registerChatRoutes, makeChatConnectFn, installAgentFn, goldmineMcpServers } from "./goldmine/chatRoutes.js";
import { collectBehaviorFindings } from "./goldmine/behaviorFindings.js";
import { RecallIndex } from "@agentgem/recall";
import { defaultRecallDbPath, serverFunnelDeps } from "./goldmine/recall.js";
import { registerRecallRoutes } from "./goldmine/recallRoutes.js";
import { ChatManager } from "@agentgem/run";
import { studioCwd, miniappDir, studioBrief, checkpointMiniapp } from "@agentgem/play";
import { availableAgents, adapterRuntimeCtx, resolveLaunch, npmAdapterInstaller, createLogger } from "@agentgem/base";
import { collectScorecard, defaultScorecardDeps } from "./gem/scorecard.js";
import { buildGoldmineBrief, type GoldmineBriefInput } from "@agentgem/insight";
import { agentgemHome } from "@agentgem/model";
import { join as pathJoin } from "node:path";
import { mkdirSync } from "node:fs";
import { originGuard } from "./originGuard.js";
import { getWarmStatus, beginForeground, endForeground } from "./warm/orchestrator.js";
import { startWarmSchedule } from "./warm/schedule.js";
import { registerDrizzle } from "@agentback/drizzle";
import { AggregatorController } from "./aggregator.controller.js";
import { ShareController } from "./share.controller.js";
import { requireShareOriginSecret } from "./originSecret.js";
import { ShareProxyController } from "./share.proxy.controller.js";
import { SourcesController } from "./sources.controller.js";
import { PlayController } from "./play.controller.js";
import { resolveAggregatorDb, type AppDb, GitHubVerifier, fetchOrgMemberships } from "@agentgem/aggregator";
import { mountGating } from "./gating.js";
import { installAuth, githubExchangeCode } from "./auth/install.js";
import { installStars } from "./stars/install.js";
import { installReviews } from "./reviews/install.js";
import { installCatalog } from "./catalog/install.js";
import { installUsage } from "./usage/install.js";
import { installRegistryUploadPublish } from "./registry/uploadPublish.js";
import { registryConfigFromEnv, githubRegistrySource, githubRegistryPublisher, defaultHttp } from "@agentgem/distribute";
import { defaultGemTypeRegistry } from "./gem/gemTypeRegistry.js";
import { appConfigFromEnv, InstallationTokens } from "./githubApp/client.js";
import { installGithubWebhook } from "./githubApp/webhook.js";
import { installGithubSetup } from "./githubApp/setupRedirect.js";
import { installOrgsApi } from "./githubApp/orgsApi.js";
import { reconcileAll, type GithubAppDeps } from "./githubApp/sync.js";

const serverLog = createLogger("server");

const here = dirname(fileURLToPath(import.meta.url));

// The React console SPA (one self-contained file). dist build path first, then a
// dev fallback to the console package's own dist; finally a placeholder.
function consoleHtml(): string {
  for (const p of [
    join(here, "public", "console", "index.html"),
    join(here, "..", "packages", "console", "dist", "index.html"),
  ]) {
    try { return readFileSync(p, "utf8"); } catch { /* try next */ }
  }
  return '<!doctype html><div id="root"></div><p>console not built — run pnpm build</p>';
}

// The bind address. Defaults to loopback so local runs stay loopback-only (the
// security model assumes 127.0.0.1); a deploy sets HOST=0.0.0.0 to accept external
// traffic, where originGuard + the public-read allowlist are the real boundary.
export function serverHost(): string {
  return process.env.HOST ?? "127.0.0.1";
}

export async function createApp(port: number): Promise<RestApplication> {
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
  app.restController(DreamController);
  app.restController(ShareProxyController);
  app.restController(SourcesController);
  app.restController(PlayController);
  app.service(GemTools);
  // Aggregator (B1) + gating: always registered now — Postgres when DATABASE_URL is set, else
  // embedded pglite for local runs (ephemeral). mountGating adds the api-key identity middleware
  // + the two-tier rate limiters over /api/aggregator. Public read endpoints are CORS-open and
  // originGuard-exempt; auth boundary is apiKeyIdentity + rate limiters.
  let aggDb: AppDb | undefined;
  {
    const { db, onStop, mode } = await resolveAggregatorDb();
    aggDb = db;
    registerDrizzle(app, db as never, { onStop });
    app.restController(AggregatorController);
    app.restController(ShareController);
    // POST /api/aggregator/share (anonymous create) is rate-limited by mountGating's anon per-IP
    // bucket below (keyed on CLIENT_IP_HEADER). That IP is only trustworthy if the request came
    // through Cloudflare, so require a CF-injected origin secret on the create (no-op until
    // ORIGIN_SHARED_SECRET is set). Public reads + /healthz are never gated.
    app.expressMiddleware("middleware.shareOriginSecret", requireShareOriginSecret);
    await mountGating(app, db);
    console.log(`aggregator: ${mode}${mode === "pglite" ? " (set DATABASE_URL for Postgres)" : ""}`);
  }
  // The persistent transcript index (capture) is a separate, lazily-opened on-disk
  // PGlite — not the aggregator DB. Close it on graceful shutdown too, so SIGTERM
  // flushes its WASM instance cleanly instead of leaving it resident until exit
  // (symmetric with the aggregator's registerDrizzle onStop). No-op if never opened.
  app.onStop(async () => { await closeSharedIndex(); });
  // CSRF / drive-by guard: reject browser-initiated cross-site requests to the loopback API
  // (controller routes). Same-origin UI and non-browser clients (CLI/MCP/tests) pass. Mounted in
  // the framework middleware chain so it runs before controller dispatch.
  app.expressMiddleware("middleware.originGuard", originGuard);
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
  // The React console (`dist/public/console`) is the UI, served at `/` (and `/console`).
  // It replaced the original vanilla UI, now removed (history in git). The gem-transfer
  // feature's backend (/api/transfer/*) ships, but its web redeem UI is not yet ported to
  // the console — use the `agentgem receive` CLI until then.
  // Liveness probe for deploy orchestrators (Cloud Run / ECS / Fly / k8s). Unauthenticated
  // and origin-less by design — registered as a raw route, so it's outside originGuard.
  server.expressApp.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  // Web sign-in (marketplace). Raw express routes (302 + Set-Cookie), outside originGuard; they set
  // their own credentialed CORS for AGENTGEM_WEB_ORIGINS. Enabled only when the OAuth secret is set.
  const ghClientId = process.env.AGENTGEM_GITHUB_CLIENT_ID;
  const ghSecret = process.env.AGENTGEM_GITHUB_CLIENT_SECRET;
  const webOrigins = (process.env.AGENTGEM_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ghClientId && ghSecret && webOrigins.length > 0 && aggDb) {
    installAuth(server.expressApp as never, {
      db: aggDb,
      verifier: new GitHubVerifier(),
      exchangeCode: githubExchangeCode(ghClientId, ghSecret),
      fetchOrgs: fetchOrgMemberships,
      config: {
        clientId: ghClientId, clientSecret: ghSecret, webOrigins,
        cookieDomain: process.env.AGENTGEM_SESSION_COOKIE_DOMAIN,
        callbackUrl: `${process.env.AGENTGEM_PUBLIC_BASE ?? "https://api.agentgem.ai"}/api/auth/github/callback`,
        stateSecret: process.env.AGENTGEM_SESSION_SECRET ?? ghSecret,
        sessionTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    });
  }
  // Stars + reviews + team usage need the DB + an allowlisted web origin; they don't need the GitHub OAuth secret.
  if (aggDb && webOrigins.length > 0) {
    installStars(server.expressApp as never, { db: aggDb, webOrigins });
    installReviews(server.expressApp as never, { db: aggDb, webOrigins });
    installCatalog(server.expressApp as never, { db: aggDb, webOrigins });
    installUsage(server.expressApp as never, { db: aggDb, webOrigins });
  }
  // GitHub App (enterprise orgs): webhook always mounts when the DB exists (503s until the three
  // GITHUB_APP_* secrets are set — the dormant contract); the /api/orgs reads mount with the same
  // preconditions as usage. Daily reconcile heals missed webhooks; 30s boot kick heals downtime.
  const ghAppCfg = appConfigFromEnv();
  const ghAppTokens = ghAppCfg ? new InstallationTokens(ghAppCfg) : null;
  const ghAppTimers: { interval?: NodeJS.Timeout; kick?: NodeJS.Timeout } = {};
  if (aggDb) {
    const ghAppDeps: GithubAppDeps = { db: aggDb, cfg: ghAppCfg, tokens: ghAppTokens, http: defaultHttp, fetchImpl: fetch };
    installGithubWebhook(server.expressApp as never, ghAppDeps);
    // Post-install Setup URL target: resolves ?installation_id → the org's catalog page.
    installGithubSetup(server.expressApp as never, { cfg: ghAppCfg });
    if (webOrigins.length > 0) installOrgsApi(server.expressApp as never, { db: aggDb, webOrigins, tokens: ghAppTokens, http: defaultHttp });
    if (ghAppCfg) {
      const runReconcile = () => void reconcileAll(ghAppDeps).catch((e) => console.error(`githubApp: reconcile failed: ${(e as Error).message}`));
      ghAppTimers.kick = setTimeout(runReconcile, 30_000);
      ghAppTimers.interval = setInterval(runReconcile, 24 * 60 * 60 * 1000);
      ghAppTimers.kick.unref?.(); ghAppTimers.interval.unref?.();
    }
  }
  // Clear the reconcile timers on graceful shutdown (same onStop pattern as closeSharedIndex above) —
  // scoped here rather than threaded out to run()'s installGracefulShutdown closure, since the timers
  // depend on aggDb/ghAppCfg which only exist inside this function.
  app.onStop(() => {
    if (ghAppTimers.kick) clearTimeout(ghAppTimers.kick);
    if (ghAppTimers.interval) clearInterval(ghAppTimers.interval);
  });
  // Registry upload-publish: requires DB, a web origin allowlist, and a GitHub registry with a
  // write token. Gate on `regCfg.token` — githubRegistryPublisher() throws without it, and a
  // deploy that sets AGENTGEM_REGISTRY_REPO but not GITHUB_TOKEN (e.g. render.yaml, where
  // publishing runs out-of-band) would otherwise crash createApp() at boot. Token-less servers
  // simply don't mount the route, since it can't publish anyway.
  const regCfg = registryConfigFromEnv();
  if (aggDb && webOrigins.length > 0 && regCfg?.token) {
    installRegistryUploadPublish(server.expressApp as never, {
      db: aggDb, webOrigins,
      source: githubRegistrySource(regCfg), publisher: githubRegistryPublisher(regCfg),
      gemTypes: defaultGemTypeRegistry,
    });
  }
  // The desktop console UI is served at `/` (and `/console`) for LOCAL runs only. The hosted
  // public deployment (api.agentgem.ai) is API-only — the console is a local desktop app, not a
  // public surface — so SERVE_CONSOLE=false disables it there and redirects `/` to the site.
  if (process.env.SERVE_CONSOLE !== "false") {
    const consolePage = consoleHtml();
    server.expressApp.get("/", (_req, res) => res.type("html").send(consolePage));
    server.expressApp.get("/console", (_req, res) => res.type("html").send(consolePage));
  } else {
    server.expressApp.get("/", (_req, res) => res.redirect(302, "https://agentgem.ai"));
  }
  // SSE progress stream for workflow analysis (raw Express — the decorator
  // framework only returns single JSON bodies). The POST /api/workflow/analyze
  // route stays for programmatic/test callers. originGuard is applied per-route because these raw
  // routes are registered directly on expressApp, outside the controller dispatch chain.
  // Read-only warm cache status. Outside any foreground gate — cheap metadata only.
  server.expressApp.get("/api/warm/status", originGuard, (_req, res) => res.json(getWarmStatus() as never));
  // Foreground gate: mark user-facing LLM computes so background warming yields.
  server.expressApp.get("/api/workflow/analyze/stream", originGuard, async (req, res) => {
    beginForeground();
    try { await streamWorkflowAnalyze(req as never, res as never); } finally { endForeground(); }
  });
  // SSE progress stream for running a Gem with a local ACP agent (materialize →
  // run → tool/token deltas → done). POST /api/gem/run stays for programmatic callers.
  server.expressApp.get("/api/gem/run/stream", originGuard, streamGemRun);
  // SSE streaming matrix: per-agent progress for a prepared cross-agent verify.
  // POST /api/gem/verify stays for programmatic callers.
  server.expressApp.get("/api/gem/verify/stream", originGuard, streamGemVerify);
  // SSE scorecard scan: per-project progress with live-climbing counts, then the
  // final aggregate scorecard. GET /api/scorecard/stream?projects=[...]&dir=...
  server.expressApp.get("/api/scorecard/stream", originGuard, (req, res) => streamScorecard(req as never, res as never));
  // SSE personal session-insights report: scan a project's transcripts → judge
  // each session with the ACP agent → synthesize. GET /api/insights/stream?root=...&dir=...
  server.expressApp.get("/api/insights/stream", originGuard, async (req, res) => {
    beginForeground();
    try { await streamInsights(req as never, res as never); } finally { endForeground(); }
  });
  // SSE rubric evaluation: run one rubric's factors over a scope's sessions → a
  // per-rubric report. GET /api/rubric/stream?rubric=<id>&scope=session|project|all&root=&sessionId=&dir=
  // A rubric may include LLM criteria (Phase 2) that drive the agent, so it takes the
  // foreground guard like the insights route (harmless for cheap-only rubrics).
  server.expressApp.get("/api/rubric/stream", originGuard, async (req, res) => {
    beginForeground();
    try { await streamRubric(req as never, res as never); } finally { endForeground(); }
  });
  // The rubric picker's catalog: built-in + user rubrics. GET /api/rubrics?dir=...
  server.expressApp.get("/api/rubrics", originGuard, (req, res) =>
    res.json({ rubrics: listRubricsWithMeta(typeof req.query.dir === "string" ? req.query.dir : undefined) } as never));
  // Authoring (validated JSON editor). Validate always returns 200 with the result so
  // the editor can render errors inline; save/delete write ~/.agentgem/rubrics/<id>.json.
  server.expressApp.post("/api/rubrics/validate", originGuard, (req, res) =>
    res.json(validateRubricInput((req as { body?: unknown }).body) as never));
  server.expressApp.post("/api/rubrics", originGuard, (req, res) =>
    res.json(saveRubric((req as { body?: unknown }).body) as never));
  server.expressApp.post("/api/rubrics/delete", originGuard, (req, res) =>
    res.json(deleteRubric((req as { body?: { id?: string } }).body?.id ?? "") as never));
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
    const adapterCtx = adapterRuntimeCtx();
    const chatConnect = makeChatConnectFn((d) => resolveLaunch(d, adapterCtx) ?? d);
    const chatManager = new ChatManager({
      connectFn: async (descriptor, connectOpts) => {
        const conn = await chatConnect(descriptor, connectOpts);  // pass through the per-session permission
        // Wrap open() to inject the server-derived neutral cwd regardless of what
        // ChatManager passes — ensures request input can never redirect the agent.
        return {
          ctx: {
            // Studio sessions may adopt their miniapp's registry dir; studioCwd allow-lists paths under
            // the miniapps root (else the neutral chatCwd), so a raw request path can never redirect here.
            open: (cwd: string, opts?: { mcpServers?: unknown[] }) =>
              conn.ctx.open(studioCwd(cwd, chatCwd), opts),
          },
          close: conn.close,
        };
      },
    });
    setInterval(() => chatManager.sweepIdle(), 60_000).unref();
    registerChatRoutes(server.expressApp as never, {
      manager: chatManager,
      resolveStudio: (miniapp: string) => ({ cwd: miniappDir(miniapp), brief: studioBrief(miniapp) }),
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
  return app;
}

// Graceful shutdown: orchestrators (k8s / Cloud Run / ECS / Fly) send SIGTERM and
// expect the process to drain in-flight work (and close the pg pool — see createApp)
// then exit within the grace period. Without this, Node exits immediately on SIGTERM,
// dropping connections. Hooks are injectable so it's unit-testable without spawning.
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

// Start the server and print where its surfaces live. Shared by the default
// entry point (below) and the `agentgem` CLI (src/cli.ts).
export async function run(port: number = Number(process.env.PORT ?? 4317)): Promise<RestApplication> {
  const app = await createApp(port);
  await app.start();
  // Background cache warming — console (local desktop) only; never on the hosted API.
  const sched = process.env.SERVE_CONSOLE !== "false" ? startWarmSchedule() : null;
  installGracefulShutdown({ stop: async () => { sched?.stop(); await app.stop(); } });
  const server = await app.restServer;
  console.log(`agentgem listening at ${server.url}`);
  console.log(`  UI:       ${server.url}/`);
  console.log(`  API:      ${server.url}/api/inventory  ·  POST ${server.url}/api/gem`);
  console.log(`  Explorer: ${server.url}/explorer/`);
  console.log(`  MCP:      ${server.url}/mcp`);
  return app;
}

if (isMain(import.meta)) {
  run().catch((err) => { console.error(err); process.exit(1); });
}
