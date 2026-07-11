// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/aggregator.controller.ts
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { api, get, post, AgentError } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb, makeAuth } from "@agentgem/aggregator";
import { AUTH_BINDING } from "./auth/mount.js";
import { ingestAttestation, ingestGemAdoption } from "@agentgem/aggregator";
import { popularity, coOccurrence, adoption, overview, coOccurrenceMatrix, modelBenchmark, effectiveness, gemAdoption } from "@agentgem/aggregator";
import { popularSkills, popularSkillGroups } from "@agentgem/aggregator";
import { buildProfile, buildOrgCatalog } from "@agentgem/aggregator";
import type { UsageAttestation, GemAdoption } from "@agentgem/insight";
import { recordBinding } from "@agentgem/aggregator";
import { GitHubVerifier } from "@agentgem/aggregator";
import { sweepQuarantine, sweepAdoptionQuarantine } from "@agentgem/aggregator";
import { issueKey, revokeKey, listKeys } from "@agentgem/aggregator";
import { recordCatalogShare, upsertGemArchive, getGemArchive, catalogGemExists, latestGemVersion, archiveOnlyVersion } from "@agentgem/aggregator";
import { recordGamePlay, gamePlayCounts } from "@agentgem/aggregator";
import { resolveSignedAccount, gemStatusFor, gemStatusSigningPayload, catalogSigningPayload, reviewActionPayload, reviewSubmitPayload, reviewResubmitPayload } from "@agentgem/aggregator";
import {
  submitReviewRequest, resubmitReviewRequest, listInbox, getReviewRequest, getReviewArchive,
  addReviewMessage, approveReviewRequest, requestChanges, withdrawReviewRequest, markSeen,
} from "@agentgem/aggregator";
import { importGem } from "@agentgem/distribute";
import { GameGenreEnum } from "./schemas.js";

// Loose body schema — the real gate is the core's verifyAttestation (ed25519 + consistency).
const IngestBody = z.object({ producer: z.object({ publicKey: z.string() }).loose(), signature: z.string(), gem: z.object({ digest: z.string() }).loose() }).loose();
const IngestResult = z.union([
  z.object({ accepted: z.literal(true), id: z.string(), publicIngredients: z.number(), privateCount: z.number(), idempotent: z.boolean() }),
  z.object({ accepted: z.literal(false), rejected: z.string() }),
]);
// Loose body schema — the real gate is verifyGemAdoption (ed25519 signature).
const AdoptBody = z.object({ producer: z.object({ publicKey: z.string() }).loose(), signature: z.string(), gemKey: z.string(), version: z.string(), gemDigest: z.string() }).loose();
const AdoptResultSchema = z.object({ accepted: z.boolean(), idempotent: z.boolean().optional(), rejected: z.string().optional() });

const PopQuery = z.object({ kind: z.string().optional(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const PopResult = z.array(z.object({ id: z.string(), kind: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() }));
const CoQuery = z.object({ id: z.string(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoResult = z.array(z.object({ id: z.string(), producers: z.number(), verifiedProducers: z.number() }));
const CoMatrixQuery = z.object({ limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoMatrixResult = z.array(z.object({ a: z.string(), b: z.string(), producers: z.number(), verifiedProducers: z.number() }));
const AdoptQuery = z.object({ id: z.string(), bucket: z.enum(["week", "month"]).optional() }); // NOTE: no `k`
const AdoptResult = z.array(z.object({ bucket: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number() }));
const OverviewResult = z.object({ ingredients: z.number(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() });
const BenchQuery = z.object({ gemDigest: z.string().optional(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const BenchResult = z.array(z.object({ model: z.string(), mostly: z.number(), partially: z.number(), notAchieved: z.number(), producers: z.number(), verifiedProducers: z.number() }));
const EffQuery = z.object({ gemName: z.string().optional(), limit: z.coerce.number().optional(), sort: z.enum(["producers", "score"]).optional(), minConfidence: z.coerce.number().min(0).max(1).optional() }); // NOTE: no `k`
const EffResult = z.array(z.object({
  gemName: z.string(), mostly: z.number(), partially: z.number(), notAchieved: z.number(), judged: z.number(),
  producers: z.number(), verifiedProducers: z.number(), organic: z.number(), confidence: z.number(), score: z.number(),
}));
const GemAdoptionQuery = z.object({ keys: z.string().optional() });
const GemAdoptionResult = z.object({ items: z.array(z.object({ gemKey: z.string(), installs: z.number(), verifiedInstalls: z.number() })) });

const PopularSkillsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sources: z.coerce.number().int().min(1).max(50).optional(),
  perSource: z.coerce.number().int().min(1).max(50).optional(),
});
const CuratedSkillSchema = z.object({
  sourceId: z.string(), source: z.string(), division: z.string(), name: z.string(), path: z.string(),
  repo: z.string(), homepage: z.string().nullable(), stars: z.number(), installs: z.number().nullable(),
  description: z.string().nullable(),
});
const CuratedSkillGroupSchema = z.object({
  sourceId: z.string(), source: z.string(), repo: z.string(), homepage: z.string().nullable(), stars: z.number(),
  skills: z.array(z.object({
    name: z.string(), path: z.string(), division: z.string(),
    description: z.string().nullable(), installs: z.number().nullable(),
  })),
});
const PopularSkillsResult = z.object({ skills: z.array(CuratedSkillSchema), groups: z.array(CuratedSkillGroupSchema) });

const ProfileQuery = z.object({ login: z.string() });
const ProfileGemSchema = z.object({
  key: z.string(), version: z.string(), description: z.string().nullable(), grade: z.number().nullable(),
  stars: z.number(), installs: z.number(), verifiedInstalls: z.number(),
});
const ProfileReviewSchema = z.object({
  sourceId: z.string(), path: z.string(), name: z.string(),
  rating: z.number(), body: z.string().nullable(), createdAt: z.string(),
});
const ProfileResult = z.object({
  login: z.string(), avatarUrl: z.string().nullable(), verified: z.boolean(),
  githubUrl: z.string().nullable(), totalStars: z.number(), gems: z.array(ProfileGemSchema),
  reviews: z.array(ProfileReviewSchema),
});

const OrgCatalogQuery = z.object({ scope: z.string() });
const RubricCheckSchema = z.object({ id: z.string(), label: z.string(), pass: z.boolean(), howToFix: z.string() });
const OrgCatalogGemSchema = z.object({
  key: z.string(), version: z.string(), cut: z.string().nullable(), grade: z.number().nullable(),
  owner: z.string(), description: z.string().nullable(),
  stars: z.number(), installs: z.number(), verifiedInstalls: z.number(),
  rubric: z.object({ score: z.number(), checks: z.array(RubricCheckSchema) }),
});
const OrgCatalogResult = z.object({
  scope: z.string(), gemCount: z.number(), ownerCount: z.number(), gems: z.array(OrgCatalogGemSchema),
});

const BindBody = z.object({ pubkey: z.string(), token: z.string(), signedAt: z.number(), signature: z.string() });
const BindResultSchema = z.union([
  z.object({ bound: z.literal(true), provider: z.string(), login: z.string(), accountId: z.string(), avatarUrl: z.string().optional(), sessionToken: z.string().optional(), expiresAt: z.string().optional() }),
  z.object({ bound: z.literal(false), rejected: z.string() }),
]);

const SweepBody = z.object({ apply: z.boolean().optional(), token: z.string() });
const SweepReportSchema = z.object({
  clustersFound: z.number(), attestationsQuarantined: z.number(), producersFlagged: z.number(), dryRun: z.boolean(),
  adoptionsQuarantined: z.number(), adoptionGemsFlagged: z.number(), adoptionProducersFlagged: z.number(),
});
const SweepResult = z.union([
  z.object({ ok: z.literal(true), report: SweepReportSchema }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);

const KeyIssueBody = z.object({ token: z.string(), label: z.string().min(1).max(120) });
const KeyIssueResult = z.union([
  z.object({ ok: z.literal(true), id: z.string(), key: z.string(), label: z.string() }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);
const KeyRevokeBody = z.object({ token: z.string(), id: z.string() });
const KeyRevokeResult = z.union([
  z.object({ ok: z.literal(true), revoked: z.boolean() }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);
const KeyListBody = z.object({ token: z.string() });
const KeyListResult = z.union([
  z.object({ ok: z.literal(true), keys: z.array(z.object({ id: z.string(), label: z.string(), createdAt: z.string(), revokedAt: z.string().nullable() })) }),
  z.object({ ok: z.literal(false), rejected: z.string() }),
]);

const CatalogManifestSchema = z.object({
  gemKey: z.string(), version: z.string(), author: z.string().optional(), description: z.string().optional(),
  tags: z.array(z.string()).optional(), artifactKinds: z.array(z.string()).optional(),
  type: z.string().optional(), grade: z.number().optional(),
  artifacts: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
  gemDigest: z.string().optional(),
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
});
const CatalogBody = z.object({ manifest: CatalogManifestSchema, pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const CatalogResult = z.object({ shared: z.boolean(), publishedBy: z.string().optional(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() });
const GemStatusBody = z.object({ key: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const GemStatusResult = z.object({ exists: z.boolean(), ownedByMe: z.boolean(), latestVersion: z.string().nullable() });
const PublishGemBody = z.object({ manifest: CatalogManifestSchema, archiveBase64: z.string(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const GemArchiveQuery = z.object({ key: z.string(), version: z.string() });
const GemArchiveResult = z.object({ archiveBase64: z.string() });
const GameHtmlResult = z.object({ html: z.string() });
const GameMetaQuery = z.object({ key: z.string(), version: z.string().optional() });
const GameMetaResult = z.object({
  title: z.string(),
  genre: GameGenreEnum,
  version: z.string(),
});
// visitorId is an opaque client-minted dedupe key, never an identity — capped, never validated.
const GamePlayBody = z.object({ gemKey: z.string(), version: z.string(), visitorId: z.string().max(64).optional() });
const GamePlayResult = z.object({ ok: z.literal(true) });
const GamePlaysQuery = z.object({ keys: z.string().optional() });
const GamePlaysResult = z.object({ items: z.array(z.object({ gemKey: z.string(), plays: z.number() })) });

const ReviewManifestWrite = z.object({
  manifest: CatalogManifestSchema, archiveBase64: z.string(), groupId: z.string().uuid(),
  description: z.string().max(4000).optional(), pubkey: z.string(), signedAt: z.number(), signature: z.string(),
});
const ReviewResubmit = z.object({
  requestId: z.string().uuid(), manifest: CatalogManifestSchema, archiveBase64: z.string(),
  description: z.string().max(4000).optional(), pubkey: z.string(), signedAt: z.number(), signature: z.string(),
});
const ReviewSigned = z.object({ requestId: z.string().uuid(), pubkey: z.string(), signedAt: z.number(), signature: z.string() });
const ReviewMessageBody = ReviewSigned.extend({ body: z.string().min(1).max(4000) });
const ReviewInboxBody = z.object({ pubkey: z.string(), signedAt: z.number(), signature: z.string() });

const ReviewSubmitResult = z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() });
const ReviewActionResult = z.object({ ok: z.boolean(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() });
const ReviewInboxResult = z.object({ requests: z.array(z.any()) });
const ReviewDetailResult = z.object({ request: z.any().nullable() });
const ReviewArchiveResult = z.object({ archiveBase64: z.string().nullable() });

// Constant-time token compare (length-guarded so timingSafeEqual never throws on mismatched lengths).
function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@api({ basePath: "/api/aggregator" })
export class AggregatorController {
  constructor(
    @inject(DrizzleBindings.CLIENT) private db: AppDb,
    @inject(AUTH_BINDING, { optional: true }) private auth?: ReturnType<typeof makeAuth>,
  ) {}

  @post("/ingest", { body: IngestBody, response: IngestResult })
  async ingest(input: { body: z.infer<typeof IngestBody> }): Promise<z.infer<typeof IngestResult>> {
    return ingestAttestation(this.db, input.body as unknown as UsageAttestation);
  }

  @post("/adopt", { body: AdoptBody, response: AdoptResultSchema })
  async adopt(input: { body: z.infer<typeof AdoptBody> }): Promise<z.infer<typeof AdoptResultSchema>> {
    return ingestGemAdoption(this.db, input.body as unknown as GemAdoption);
  }

  @get("/popularity", { query: PopQuery, response: PopResult })
  async popularity(input: { query: z.infer<typeof PopQuery> }): Promise<z.infer<typeof PopResult>> {
    // k is NEVER taken from the caller — the floor is server policy (DEFAULT_K).
    return popularity(this.db, { kind: input.query.kind, limit: input.query.limit });
  }

  @get("/co-occurrence", { query: CoQuery, response: CoResult })
  async coOccurrence(input: { query: z.infer<typeof CoQuery> }): Promise<z.infer<typeof CoResult>> {
    return coOccurrence(this.db, { id: input.query.id, limit: input.query.limit });
  }

  @get("/co-occurrence-matrix", { query: CoMatrixQuery, response: CoMatrixResult })
  async coOccurrenceMatrix(input: { query: z.infer<typeof CoMatrixQuery> }): Promise<z.infer<typeof CoMatrixResult>> {
    // k is server policy (DEFAULT_K), never caller-supplied.
    return coOccurrenceMatrix(this.db, { limit: input.query.limit });
  }

  @get("/adoption", { query: AdoptQuery, response: AdoptResult })
  async adoption(input: { query: z.infer<typeof AdoptQuery> }): Promise<z.infer<typeof AdoptResult>> {
    return adoption(this.db, { id: input.query.id, bucket: input.query.bucket });
  }

  @get("/overview", { response: OverviewResult })
  async overview(): Promise<z.infer<typeof OverviewResult>> {
    // No query params; k is server policy (DEFAULT_K), never caller-supplied.
    return overview(this.db, {});
  }

  // Cross-model benchmark: per-model success rates aggregated across producers,
  // optionally scoped to one gem. k is server policy (DEFAULT_K), never caller-supplied.
  @get("/benchmarks", { query: BenchQuery, response: BenchResult })
  async benchmarks(input: { query: z.infer<typeof BenchQuery> }): Promise<z.infer<typeof BenchResult>> {
    return modelBenchmark(this.db, { gemDigest: input.query.gemDigest, limit: input.query.limit });
  }

  // Per-gem effectiveness: confidence-weighted success rate over judged sessions,
  // aggregated across models/versions and k-anonymised on producers. `sort=score`
  // + `minConfidence` yield an effectiveness leaderboard. k is server policy.
  @get("/effectiveness", { query: EffQuery, response: EffResult })
  async effectiveness(input: { query: z.infer<typeof EffQuery> }): Promise<z.infer<typeof EffResult>> {
    return effectiveness(this.db, { gemName: input.query.gemName, limit: input.query.limit, sort: input.query.sort, minConfidence: input.query.minConfidence });
  }

  // Gem-level k-anon install counts. k is server policy (DEFAULT_K), never caller-supplied.
  @get("/gem-adoption", { query: GemAdoptionQuery, response: GemAdoptionResult })
  async gemAdoption(input: { query: z.infer<typeof GemAdoptionQuery> }): Promise<z.infer<typeof GemAdoptionResult>> {
    const keys = input.query.keys ? input.query.keys.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return { items: await gemAdoption(this.db, { keys }) };
  }

  // Public "Popular Skills" board: skills discovered across the curated sources (see
  // curatedSkillsIndexer.ts). `skills` (flat, installs-then-stars ranked) is kept for back-compat
  // with the live marketplace; `groups` (by source, ordered by the source repo's GitHub stars) is
  // the grouped board the current marketplace UI renders. No k-anon floor — this is public repo
  // metadata, not producer-derived usage data.
  @get("/popular-skills", { query: PopularSkillsQuery, response: PopularSkillsResult })
  async popularSkills(input: { query: z.infer<typeof PopularSkillsQuery> }): Promise<z.infer<typeof PopularSkillsResult>> {
    return {
      skills: await popularSkills(this.db, { limit: input.query.limit ?? 50 }),
      groups: await popularSkillGroups(this.db, { sources: input.query.sources, perSource: input.query.perSource }),
    };
  }

  // Public profile: avatar + verified flag + published gems with k-anon engagement. login is a query
  // param (every route here is query-based; the pretty /@login is a frontend route). 404 when absent.
  @get("/profile", { query: ProfileQuery, response: ProfileResult })
  async profile(input: { query: z.infer<typeof ProfileQuery> }): Promise<z.infer<typeof ProfileResult>> {
    const p = await buildProfile(this.db, input.query.login);
    if (!p) throw new AgentError("profile not found", { status: 404, code: "profile_not_found", retryable: false });
    return p;
  }

  // Public org catalog: all gems keyed @scope/* with a per-gem maturity rubric. Unknown scope → empty
  // catalog (200); malformed scope → 400. scope is a query param so it needs no path-decoding.
  @get("/org-catalog", { query: OrgCatalogQuery, response: OrgCatalogResult })
  async orgCatalog(input: { query: z.infer<typeof OrgCatalogQuery> }): Promise<z.infer<typeof OrgCatalogResult>> {
    const c = await buildOrgCatalog(this.db, input.query.scope);
    if (!c) throw new AgentError("invalid scope", { status: 400, code: "invalid_scope", retryable: false });
    return c;
  }

  @post("/bind", { body: BindBody, response: BindResultSchema })
  async bind(input: { body: z.infer<typeof BindBody> }): Promise<z.infer<typeof BindResultSchema>> {
    // GitHubVerifier is the live provider; recordBinding does signature + freshness + producer checks.
    return recordBinding(this.db, input.body as z.infer<typeof BindBody>, new GitHubVerifier(), undefined, undefined, this.auth);
  }

  // Not-connected is NOT an HTTP error — stays 200 with { shared: false, rejected: "not-connected" },
  // same shape as /bind's rejection.
  //
  // Abuse protection: this path lives under AGG_PATH, so it inherits the anonymous per-IP rate
  // limiter (gating.ts `anonRateLimitOptions` — only /keys*, /sweep, /ingest are skipped). Combined
  // with the mandatory ed25519 signature + account binding, that is sufficient; a dedicated
  // per-pubkey limiter is deferred until real abuse justifies the extra machinery.
  @post("/catalog", { body: CatalogBody, response: CatalogResult })
  async catalog(input: { body: z.infer<typeof CatalogBody> }): Promise<z.infer<typeof CatalogResult>> {
    const r = await recordCatalogShare(this.db, input.body);
    return r.shared
      ? { shared: true, publishedBy: r.publishedBy, gemKey: r.gemKey, version: r.version }
      : { shared: false, rejected: r.rejected };
  }

  // Pre-flight for the publish dialog. Signed like /catalog — the console has no session cookie; it
  // authenticates with its ed25519 producer key. Existence + latest are public; ownedByMe is true
  // only for the verified owner. Auth failure ⇒ public info with ownedByMe:false.
  @post("/gem-status", { body: GemStatusBody, response: GemStatusResult })
  async gemStatus(input: { body: z.infer<typeof GemStatusBody> }): Promise<z.infer<typeof GemStatusResult>> {
    const b = input.body;
    const who = await resolveSignedAccount(this.db, {
      pubkey: b.pubkey, payload: gemStatusSigningPayload(b.key, b.pubkey, b.signedAt), signedAt: b.signedAt, signature: b.signature,
    });
    return gemStatusFor(this.db, b.key, who.ok ? who.accountId : null);
  }

  // Installable publish: the signed catalog share PLUS the .gem archive bytes. Verifies the archive
  // (importGem checks gem.lock), binds it to the signed manifest via gemDigest, then stores both so
  // the gem becomes installable. publishedBy stays server-derived (recordCatalogShare).
  @post("/publish-gem", { body: PublishGemBody, response: CatalogResult })
  async publishGem(input: { body: z.infer<typeof PublishGemBody> }): Promise<z.infer<typeof CatalogResult>> {
    const bytes = Buffer.from(input.body.archiveBase64, "base64");
    let digest: string;
    try {
      digest = importGem(bytes).meta.gemDigest; // throws on tamper / bad lock
    } catch {
      throw new AgentError("invalid gem archive", { status: 400, code: "invalid_archive", retryable: false });
    }
    if (input.body.manifest.gemDigest && input.body.manifest.gemDigest !== digest) {
      return { shared: false, rejected: "digest-mismatch" };
    }
    const r = await recordCatalogShare(this.db, { manifest: input.body.manifest, pubkey: input.body.pubkey, signedAt: input.body.signedAt, signature: input.body.signature });
    if (!r.shared) return { shared: false, rejected: r.rejected };
    await upsertGemArchive(this.db, { gemKey: r.gemKey, version: r.version, bytes: new Uint8Array(bytes), digest, createdAtMs: Date.now() });
    return { shared: true, publishedBy: r.publishedBy, gemKey: r.gemKey, version: r.version };
  }

  // Public: stream a published gem's archive bytes (base64) for zero-config install. Serves only
  // gems whose content was uploaded (gem_archives row present). originGuard PUBLIC_READ-exempt.
  @get("/gem-archive", { query: GemArchiveQuery, response: GemArchiveResult })
  async gemArchive(input: { query: z.infer<typeof GemArchiveQuery> }): Promise<z.infer<typeof GemArchiveResult>> {
    const a = await getGemArchive(this.db, input.query.key, input.query.version);
    if (!a) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    return { archiveBase64: Buffer.from(a.bytes).toString("base64") };
  }

  // The sealed HTML of a gem's game artifact, so the marketplace can PLAY mini-games inline (in a
  // sandboxed iframe). 404 if the gem has no game. The server owns the archive parser; the SPA gets a
  // ready-to-seal string. (A broker-fed replay game has no baked data → it shows its waiting state.)
  @get("/game-html", { query: GemArchiveQuery, response: GameHtmlResult })
  async gameHtml(input: { query: z.infer<typeof GemArchiveQuery> }): Promise<z.infer<typeof GameHtmlResult>> {
    const a = await getGemArchive(this.db, input.query.key, input.query.version);
    if (!a) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    const { gem } = importGem(Buffer.from(a.bytes));
    const game = gem.artifacts.find((x) => x.type === "game") as { html?: unknown } | undefined;
    if (!game || typeof game.html !== "string") throw new AgentError("this gem has no game to play", { status: 404, code: "not_a_game", retryable: false });
    return { html: game.html };
  }

  // Public: title/genre for a game addressed by BARE key (/games/@scope/name), resolving "latest" to
  // the most recently published version. The Play page renders a heading from this before the (up to
  // 1.5 MB) sealed HTML arrives. originGuard PUBLIC_READ-exempt.
  @get("/game-meta", { query: GameMetaQuery, response: GameMetaResult })
  async gameMeta(input: { query: z.infer<typeof GameMetaQuery> }): Promise<z.infer<typeof GameMetaResult>> {
    const { key } = input.query;
    const version = input.query.version ?? (await latestGemVersion(this.db, key)) ?? (await archiveOnlyVersion(this.db, key));
    if (!version) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    const a = await getGemArchive(this.db, key, version);
    if (!a) throw new AgentError("gem archive not found", { status: 404, code: "gem_archive_not_found", retryable: false });
    const { gem } = importGem(Buffer.from(a.bytes));
    const game = gem.artifacts.find((x) => x.type === "game") as { title?: unknown; genre?: unknown } | undefined;
    if (!game || typeof game.title !== "string") throw new AgentError("this gem has no game to play", { status: 404, code: "not_a_game", retryable: false });
    return { title: game.title, genre: game.genre as z.infer<typeof GameMetaResult>["genre"], version };
  }

  // A reader clicked into a mini-game's fullscreen play. Unauthenticated by design — the arcade needs
  // no login — so this counts CLICKS, not people, and a determined caller can inflate it. The published
  // gem must exist, which is what keeps the table to real games instead of arbitrary caller-named keys.
  @post("/game-play", { body: GamePlayBody, response: GamePlayResult })
  async gamePlay(input: { body: z.infer<typeof GamePlayBody> }): Promise<z.infer<typeof GamePlayResult>> {
    const { gemKey, version, visitorId } = input.body;
    if (!(await catalogGemExists(this.db, gemKey, version))) throw new AgentError("gem not found", { status: 404, code: "gem_not_found", retryable: false });
    await recordGamePlay(this.db, { gemKey, version, visitorId });
    return { ok: true };
  }

  // Play counts for the arcade cards. Plays only: the visitor id behind them is a dedupe key, and
  // publishing a "unique" number from it would be claiming an identity the arcade never collects.
  @get("/game-plays", { query: GamePlaysQuery, response: GamePlaysResult })
  async gamePlays(input: { query: z.infer<typeof GamePlaysQuery> }): Promise<z.infer<typeof GamePlaysResult>> {
    const keys = input.query.keys ? input.query.keys.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return { items: await gamePlayCounts(this.db, { keys }) };
  }

  // Admin-only: run the anti-sybil quarantine sweep. Dry-run by default; apply=true is
  // destructive and requires AGGREGATOR_ADMIN_TOKEN. Do NOT log input.body (it has the token).
  @post("/sweep", { body: SweepBody, response: SweepResult })
  async sweep(input: { body: z.infer<typeof SweepBody> }): Promise<z.infer<typeof SweepResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "sweep-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const report = await sweepQuarantine(this.db, { dryRun: !input.body.apply });
    const ad = await sweepAdoptionQuarantine(this.db, { dryRun: !input.body.apply });
    return { ok: true, report: { ...report, adoptionsQuarantined: ad.adoptionsQuarantined, adoptionGemsFlagged: ad.gemsFlagged, adoptionProducersFlagged: ad.producersFlagged } };
  }

  // Admin-only: mint an API key. Gated by AGGREGATOR_ADMIN_TOKEN (like /sweep). The plaintext
  // is returned ONCE; only its hash is stored. Do NOT log input.body (it has the token).
  @post("/keys", { body: KeyIssueBody, response: KeyIssueResult })
  async issueKey(input: { body: z.infer<typeof KeyIssueBody> }): Promise<z.infer<typeof KeyIssueResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const { id, plaintext, label } = await issueKey(this.db, input.body.label);
    return { ok: true, id, key: plaintext, label };
  }

  @post("/keys/revoke", { body: KeyRevokeBody, response: KeyRevokeResult })
  async revokeKey(input: { body: z.infer<typeof KeyRevokeBody> }): Promise<z.infer<typeof KeyRevokeResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    return { ok: true, revoked: await revokeKey(this.db, input.body.id) };
  }

  // POST (not GET) so the admin token travels in the body, never a URL/query that lands in logs.
  @post("/keys/list", { body: KeyListBody, response: KeyListResult })
  async listKeys(input: { body: z.infer<typeof KeyListBody> }): Promise<z.infer<typeof KeyListResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "keys-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const keys = (await listKeys(this.db)).map((k) => ({
      id: k.id, label: k.label, createdAt: k.createdAt.toISOString(), revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
    }));
    return { ok: true, keys };
  }

  // Shared account resolution for every /review/* route: verify the signature over `payload` and
  // resolve it to an authorizing accounts.id. Each caller builds a payload scoped to ITS route so a
  // captured signature can't be replayed elsewhere: reviewSubmitPayload (binds groupId, distinct
  // from catalogSigningPayload so a /review/request body can't be replayed to /publish-gem or
  // /catalog), reviewResubmitPayload (binds requestId, distinct from submit's), or reviewActionPayload
  // (action verb + requestId, for the manifest-less actions: approve/changes/withdraw/seen/get/
  // archive/message/inbox). Fail-closed: an unbound/unresolvable/stale/bad key is always a 401, never
  // a silent no-op.
  private async signedAccount(payload: string, body: { pubkey: string; signedAt: number; signature: string }) {
    const who = await resolveSignedAccount(this.db, { pubkey: body.pubkey, payload, signedAt: body.signedAt, signature: body.signature });
    if (!who.ok) throw new AgentError("not authorized", { status: 401, code: "review_unauthorized", retryable: false });
    return who; // { ok:true, accountId, login }
  }

  // Submit a draft gem to a group for review. D3: the manifest's advertised digest MUST match the
  // real archive bytes, so a staged (and later published) row never claims a hash its bytes don't
  // have — mirrors /publish-gem's guard exactly.
  @post("/review/request", { body: ReviewManifestWrite, response: ReviewSubmitResult })
  async reviewRequest(input: { body: z.infer<typeof ReviewManifestWrite> }): Promise<z.infer<typeof ReviewSubmitResult>> {
    const b = input.body;
    const who = await this.signedAccount(reviewSubmitPayload(b.manifest, b.groupId, b.pubkey, b.signedAt), b);
    const bytes = new Uint8Array(Buffer.from(b.archiveBase64, "base64"));
    let digest: string;
    try {
      digest = importGem(Buffer.from(bytes)).meta.gemDigest; // throws on tamper / bad lock
    } catch {
      throw new AgentError("invalid gem archive", { status: 400, code: "invalid_archive", retryable: false });
    }
    if (b.manifest.gemDigest !== digest) throw new AgentError("manifest digest does not match archive", { status: 400, code: "review_digest_mismatch", retryable: false });
    const r = await submitReviewRequest(this.db, { accountId: who.accountId, groupId: b.groupId, manifest: b.manifest, archiveBytes: bytes, archiveDigest: digest, description: b.description });
    return r.ok ? { ok: true, requestId: r.requestId } : { ok: false, rejected: r.rejected };
  }

  // The author resubmits new bytes/manifest after changes were requested. Same D3 digest guard as submit.
  @post("/review/resubmit", { body: ReviewResubmit, response: ReviewActionResult })
  async reviewResubmit(input: { body: z.infer<typeof ReviewResubmit> }): Promise<z.infer<typeof ReviewActionResult>> {
    const b = input.body;
    const who = await this.signedAccount(reviewResubmitPayload(b.manifest, b.requestId, b.pubkey, b.signedAt), b);
    const bytes = new Uint8Array(Buffer.from(b.archiveBase64, "base64"));
    let digest: string;
    try {
      digest = importGem(Buffer.from(bytes)).meta.gemDigest;
    } catch {
      throw new AgentError("invalid gem archive", { status: 400, code: "invalid_archive", retryable: false });
    }
    if (b.manifest.gemDigest !== digest) throw new AgentError("manifest digest does not match archive", { status: 400, code: "review_digest_mismatch", retryable: false }); // D3, mirrors submit
    const r = await resubmitReviewRequest(this.db, { accountId: who.accountId, requestId: b.requestId, manifest: b.manifest, archiveBytes: bytes, archiveDigest: digest, description: b.description });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }

  // Open/changes-requested requests across every group the caller belongs to. POST (not GET) because
  // the signature travels in the body, same reason /game-play is POST.
  @post("/review/inbox", { body: ReviewInboxBody, response: ReviewInboxResult })
  async reviewInbox(input: { body: z.infer<typeof ReviewInboxBody> }): Promise<z.infer<typeof ReviewInboxResult>> {
    const who = await this.signedAccount(reviewActionPayload("inbox", "", input.body.pubkey, input.body.signedAt), input.body);
    return { requests: await listInbox(this.db, who.accountId) };
  }

  @post("/review/get", { body: ReviewSigned, response: ReviewDetailResult })
  async reviewGet(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewDetailResult>> {
    const who = await this.signedAccount(reviewActionPayload("get", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    await markSeen(this.db, who.accountId, input.body.requestId); // opening the detail marks it read
    return { request: await getReviewRequest(this.db, who.accountId, input.body.requestId) };
  }

  @post("/review/archive", { body: ReviewSigned, response: ReviewArchiveResult })
  async reviewArchive(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewArchiveResult>> {
    const who = await this.signedAccount(reviewActionPayload("archive", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    const a = await getReviewArchive(this.db, who.accountId, input.body.requestId);
    return { archiveBase64: a ? Buffer.from(a.bytes).toString("base64") : null };
  }

  @post("/review/message", { body: ReviewMessageBody, response: ReviewActionResult })
  async reviewMessage(input: { body: z.infer<typeof ReviewMessageBody> }): Promise<z.infer<typeof ReviewActionResult>> {
    const b = input.body;
    const who = await this.signedAccount(reviewActionPayload("message:" + b.body, b.requestId, b.pubkey, b.signedAt), b);
    const r = await addReviewMessage(this.db, { accountId: who.accountId, requestId: b.requestId, body: b.body });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }

  @post("/review/approve", { body: ReviewSigned, response: ReviewActionResult })
  async reviewApprove(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
    const who = await this.signedAccount(reviewActionPayload("approve", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    const r = await approveReviewRequest(this.db, { accountId: who.accountId, requestId: input.body.requestId });
    return r.ok ? { ok: true, gemKey: r.gemKey, version: r.version } : { ok: false, rejected: r.rejected };
  }

  @post("/review/changes", { body: ReviewSigned, response: ReviewActionResult })
  async reviewChanges(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
    const who = await this.signedAccount(reviewActionPayload("changes", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    const r = await requestChanges(this.db, { accountId: who.accountId, requestId: input.body.requestId });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }

  @post("/review/withdraw", { body: ReviewSigned, response: ReviewActionResult })
  async reviewWithdraw(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
    const who = await this.signedAccount(reviewActionPayload("withdraw", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    const r = await withdrawReviewRequest(this.db, { accountId: who.accountId, requestId: input.body.requestId });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }

  @post("/review/seen", { body: ReviewSigned, response: ReviewActionResult })
  async reviewSeen(input: { body: z.infer<typeof ReviewSigned> }): Promise<z.infer<typeof ReviewActionResult>> {
    const who = await this.signedAccount(reviewActionPayload("seen", input.body.requestId, input.body.pubkey, input.body.signedAt), input.body);
    await markSeen(this.db, who.accountId, input.body.requestId);
    return { ok: true };
  }
}
