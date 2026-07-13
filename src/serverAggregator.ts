// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/serverAggregator.ts
//
// Extracted from src/index.ts (Task 4, pure move — no behaviour change): everything createApp
// mounts on top of the aggregator DB — the aggregator + share controllers, gating, better-auth
// (+ desktop handoff, Flow B connect, the boot-time migrate/backfill), stars/reviews/catalog/
// groups/gemShares/usage/handles/account, OG cards, the GitHub App (webhook/setup/orgsApi +
// reconcile timers), and registry upload-publish. Called once from createApp, after
// `const server = await app.restServer` is resolved.
import type { RestApplication } from "@agentback/rest";
import { REST_DISPATCH_HOOK_TAG } from "@agentback/rest";
import { registerDrizzle } from "@agentback/drizzle";
import { AggregatorController } from "./aggregator.controller.js";
import { gameHtmlCache } from "./arcadeCache.js";
import { ShareController } from "./share.controller.js";
import { requireShareOriginSecret } from "./originSecret.js";
import { resolveAggregatorDb, type AppDb, migrateAccountsToBetterAuth, backfillUserHandles } from "@agentgem/aggregator";
import { mountGating } from "./gating.js";
import { installHandoff } from "./auth/handoff.js";
import { mountAuth, AUTH_BINDING } from "./auth/mount.js";
import { deriveRpId } from "./auth/passkeyRpId.js";
import { makeAuth } from "@agentgem/aggregator";
import { installStars } from "./stars/install.js";
import { installReviews } from "./reviews/install.js";
import { installCatalog } from "./catalog/install.js";
import { installOg } from "./og/install.js";
import { installGemShares } from "./catalog/shares.js";
import { installGroups } from "./groups/install.js";
import { installHandles } from "./handles/install.js";
import { installAccount } from "./account/install.js";
import { installConnect } from "./account/connect.js";
import { installUsage } from "./usage/install.js";
import { installRegistryUploadPublish } from "./registry/uploadPublish.js";
import { registryConfigFromEnv, githubRegistrySource, githubRegistryPublisher, defaultHttp } from "@agentgem/distribute";
import { defaultGemTypeRegistry } from "./gem/gemTypeRegistry.js";
import { appConfigFromEnv, InstallationTokens } from "./githubApp/client.js";
import { installGithubWebhook } from "./githubApp/webhook.js";
import { installGithubSetup } from "./githubApp/setupRedirect.js";
import { installOrgsApi } from "./githubApp/orgsApi.js";
import { reconcileAll, type GithubAppDeps } from "./githubApp/sync.js";

// Boot-time accounts→better-auth backfill, re-run at cutover (Plan 1b-Task 5): a conflict means a
// (provider, providerAccountId) pair already resolves to a DIFFERENT better-auth user than its
// legacy `accounts` row — proceeding would let better-auth authorize the WRONG identity for that
// account, so this fails startup loudly rather than degrading silently (the pre-cutover behavior,
// which only logged and let boot continue). Exported for direct testing without spinning up createApp.
export async function migrateAccountsOrFail(db: AppDb): Promise<{ migrated: number }> {
  const { migrated, conflicts } = await migrateAccountsToBetterAuth(db);
  if (conflicts.length > 0) {
    console.error(`better-auth migration: ${conflicts.length} account link conflict(s) — refusing to boot:`, conflicts);
    throw new Error(`better-auth migration: ${conflicts.length} account link conflict(s) must be resolved before cutover: ${conflicts.join(", ")}`);
  }
  return { migrated };
}

export async function mountAggregator(
  app: RestApplication,
  server: Awaited<RestApplication["restServer"]>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
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
    // The arcade's sealed-game read is versioned, re-read by every card on the Miniapps grid, and
    // expensive to serve (bytea out of Postgres, then unzip) — give it a short max-age so a repeat
    // visit skips the request, but never `immutable` since a republish reuses the same (key,
    // version). Bound here (not buildCommonApp) because it keys on AggregatorController, which the
    // desktop client entry never mounts — see arcadeCache.ts's module comment.
    app.bind("hooks.gameHtmlCache").to(gameHtmlCache).tag(REST_DISPATCH_HOOK_TAG);
    // POST /api/aggregator/share (anonymous create) is rate-limited by mountGating's anon per-IP
    // bucket below (keyed on CLIENT_IP_HEADER). That IP is only trustworthy if the request came
    // through Cloudflare, so require a CF-injected origin secret on the create (no-op until
    // ORIGIN_SHARED_SECRET is set). Public reads + /healthz are never gated.
    app.expressMiddleware("middleware.shareOriginSecret", requireShareOriginSecret);
    await mountGating(app, db);
    console.log(`aggregator: ${mode}${mode === "pglite" ? " (set DATABASE_URL for Postgres)" : ""}`);
  }
  // Web sign-in (marketplace), served by better-auth at /api/auth. Raw express routes (302 +
  // Set-Cookie), outside originGuard; mountAuth sets its own credentialed CORS for
  // AGENTGEM_WEB_ORIGINS. Enabled only when the OAuth secret is set.
  const ghClientId = env.AGENTGEM_GITHUB_CLIENT_ID;
  const ghSecret = env.AGENTGEM_GITHUB_CLIENT_SECRET;
  const googleClientId = env.AGENTGEM_GOOGLE_CLIENT_ID;
  const googleClientSecret = env.AGENTGEM_GOOGLE_CLIENT_SECRET;
  const webOrigins = (env.AGENTGEM_WEB_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Hoisted so the route installers below (stars/reviews/catalog/groups/usage/orgsApi/registry) can
  // reuse the SAME instance resolveSession(auth, headers) resolves sessions through (Plan 1b) —
  // also bound into the DI container so GemController can inject it (see AUTH_BINDING).
  let auth: ReturnType<typeof makeAuth> | undefined;
  if (ghClientId && ghSecret && webOrigins.length > 0 && aggDb) {
    // better-auth is now authoritative (Plan 1b-Task 5: the hand-rolled OAuth it coexisted with
    // under the temporary /api/betterauth prefix is deleted) — mounted at the real /api/auth prefix.
    auth = makeAuth({
      db: aggDb,
      secret: env.AGENTGEM_SESSION_SECRET ?? ghSecret,
      baseURL: `${env.AGENTGEM_PUBLIC_BASE ?? "https://api.agentgem.ai"}/api/auth`,
      githubClientId: ghClientId,
      githubClientSecret: ghSecret,
      googleClientId,
      googleClientSecret,
      webOrigins,
      cookieDomain: env.AGENTGEM_SESSION_COOKIE_DOMAIN,
      passkeyRpId: deriveRpId(env.AGENTGEM_PASSKEY_RP_ID, env.AGENTGEM_SESSION_COOKIE_DOMAIN),
    });
    app.bind(AUTH_BINDING).to(auth);
    // Desktop→web SSO handoff (1b-Task 4): registered BEFORE mountAuth's catch-all below. better-auth
    // now owns the real "/api/auth" prefix, so these two paths ("/api/auth/handoff/start",
    // "/api/auth/handoff/redeem") sit UNDER better-auth's own catch-all namespace — Express dispatches
    // to the FIRST matching route registered, so installHandoff must run first or the catch-all would
    // swallow them. Neither path collides with a better-auth-served route (sign-in/*, sign-out,
    // get-session, callback/*, ...).
    // Flow B bespoke connect (Task 2): its callback shim sits at better-auth's OWN callback path
    // (/api/auth/callback/:provider) and routes on `state` — OUR state we exchange, any foreign state
    // it next()s through. Like installHandoff, it MUST register BEFORE mountAuth's /api/auth/*splat
    // catch-all so Express dispatches to it first (and its next() then falls through to better-auth).
    installConnect(server.expressApp as never, { db: aggDb, auth, webOrigins, publicBase: webOrigins[0] ?? "" });
    installHandoff(server.expressApp as never, { db: aggDb, auth, config: { webOrigins } });
    mountAuth(server.expressApp as never, auth, webOrigins, "/api/auth");
    // Re-run the boot backfill at cutover (Plan 1b-Task 5): the 1a boot backfill only caught accounts
    // that existed at boot, but the old OAuth (now deleted) kept creating `accounts` rows through
    // 1a's additive window. Every legacy account must have its same-id better-auth user/account
    // anchor before better-auth becomes authoritative, so this fails startup loudly on a conflict —
    // see migrateAccountsOrFail below.
    const { migrated } = await migrateAccountsOrFail(aggDb);
    console.log(`better-auth migration: backfilled ${migrated} account(s)`);
    // Re-run the handle backfill at cutover too (5b fix pass): migrateAccountsOrFail (above) is what
    // mirrors legacy `accounts` rows into "user" rows, and it runs AFTER ensureSchema's own
    // backfillUserHandles call — so any account created via the old OAuth path since the last boot
    // gets its "user" row created here, too late for that earlier pass to claim its handle. Left
    // alone, that account has handle = NULL for this whole boot: buildProfile resolves handle ->
    // accountId and 404s with none, so the profile and its gems are effectively invisible until the
    // next boot or the user's next re-login. backfillUserHandles is idempotent, so calling it again
    // only claims the newly-mirrored rows and is cheap.
    const rebackfill = await backfillUserHandles(aggDb);
    if (rebackfill.claimed > 0) {
      console.log(`better-auth migration: backfilled ${rebackfill.claimed} handle(s) for newly-mirrored user(s)`);
    }
  }
  // Stars + reviews + team usage need the DB + an allowlisted web origin + a live better-auth
  // instance to resolve sessions through (Plan 1b) — the last of which needs the GitHub OAuth
  // secret to construct (see `auth` above), so these implicitly need it too now: without it, no
  // session could ever have been minted anyway, so there is nothing for these routes to serve.
  if (aggDb && webOrigins.length > 0 && auth) {
    installStars(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installReviews(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installCatalog(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installGroups(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installGemShares(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installUsage(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installHandles(server.expressApp as never, { db: aggDb, auth, webOrigins });
    installAccount(server.expressApp as never, { db: aggDb, auth, webOrigins });
  }
  // Deployment-agnostic OG cards. Only needs the DB (no auth/web-origins) so a bare aggregator
  // still registers card routes. assetOrigin = where the built SPA index.html lives; ogImageOrigin =
  // the public host whose /og/card.png crawlers fetch. Both default to the public app host and are
  // overridable so a non-Cloudflare deploy needs zero code change.
  if (aggDb) {
    const ogAssetOrigin = env.AGENTGEM_ASSET_ORIGIN ?? "https://app.agentgem.ai";
    const ogImageOrigin = env.AGENTGEM_OG_IMAGE_ORIGIN ?? "https://app.agentgem.ai";
    installOg(server.expressApp as never, { db: aggDb, assetOrigin: ogAssetOrigin, ogImageOrigin });
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
    if (webOrigins.length > 0 && auth) installOrgsApi(server.expressApp as never, { db: aggDb, auth, webOrigins, tokens: ghAppTokens, http: defaultHttp });
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
  if (aggDb && webOrigins.length > 0 && regCfg?.token && auth) {
    installRegistryUploadPublish(server.expressApp as never, {
      db: aggDb, auth, webOrigins,
      source: githubRegistrySource(regCfg), publisher: githubRegistryPublisher(regCfg),
      gemTypes: defaultGemTypeRegistry,
    });
  }
}
