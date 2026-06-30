// src/aggregator.controller.ts
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { api, get, post } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "@agentgem/aggregator";
import { ingestAttestation } from "@agentgem/aggregator";
import { popularity, coOccurrence, adoption, overview, coOccurrenceMatrix } from "@agentgem/aggregator";
import type { UsageAttestation } from "@agentgem/insight";
import { recordBinding } from "@agentgem/aggregator";
import { GitHubVerifier } from "@agentgem/aggregator";
import { sweepQuarantine } from "@agentgem/aggregator";
import { issueKey, revokeKey, listKeys } from "@agentgem/aggregator";

// Loose body schema — the real gate is the core's verifyAttestation (ed25519 + consistency).
const IngestBody = z.object({ producer: z.object({ publicKey: z.string() }).loose(), signature: z.string(), gem: z.object({ digest: z.string() }).loose() }).loose();
const IngestResult = z.union([
  z.object({ accepted: z.literal(true), id: z.string(), publicIngredients: z.number(), privateCount: z.number(), idempotent: z.boolean() }),
  z.object({ accepted: z.literal(false), rejected: z.string() }),
]);
const PopQuery = z.object({ kind: z.string().optional(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const PopResult = z.array(z.object({ id: z.string(), kind: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() }));
const CoQuery = z.object({ id: z.string(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoResult = z.array(z.object({ id: z.string(), producers: z.number(), verifiedProducers: z.number() }));
const CoMatrixQuery = z.object({ limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoMatrixResult = z.array(z.object({ a: z.string(), b: z.string(), producers: z.number(), verifiedProducers: z.number() }));
const AdoptQuery = z.object({ id: z.string(), bucket: z.enum(["week", "month"]).optional() }); // NOTE: no `k`
const AdoptResult = z.array(z.object({ bucket: z.string(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number() }));
const OverviewResult = z.object({ ingredients: z.number(), producers: z.number(), verifiedProducers: z.number(), invocations: z.number(), sessions: z.number() });
const BindBody = z.object({ pubkey: z.string(), token: z.string(), signedAt: z.number(), signature: z.string() });
const BindResultSchema = z.union([
  z.object({ bound: z.literal(true), provider: z.string(), login: z.string(), accountId: z.string() }),
  z.object({ bound: z.literal(false), rejected: z.string() }),
]);

const SweepBody = z.object({ apply: z.boolean().optional(), token: z.string() });
const SweepReportSchema = z.object({
  clustersFound: z.number(), attestationsQuarantined: z.number(), producersFlagged: z.number(), dryRun: z.boolean(),
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

// Constant-time token compare (length-guarded so timingSafeEqual never throws on mismatched lengths).
function tokenEq(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@api({ basePath: "/api/aggregator" })
export class AggregatorController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}

  @post("/ingest", { body: IngestBody, response: IngestResult })
  async ingest(input: { body: z.infer<typeof IngestBody> }): Promise<z.infer<typeof IngestResult>> {
    return ingestAttestation(this.db, input.body as unknown as UsageAttestation);
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

  @post("/bind", { body: BindBody, response: BindResultSchema })
  async bind(input: { body: z.infer<typeof BindBody> }): Promise<z.infer<typeof BindResultSchema>> {
    // GitHubVerifier is the live provider; recordBinding does signature + freshness + producer checks.
    return recordBinding(this.db, input.body as z.infer<typeof BindBody>, new GitHubVerifier());
  }

  // Admin-only: run the anti-sybil quarantine sweep. Dry-run by default; apply=true is
  // destructive and requires AGGREGATOR_ADMIN_TOKEN. Do NOT log input.body (it has the token).
  @post("/sweep", { body: SweepBody, response: SweepResult })
  async sweep(input: { body: z.infer<typeof SweepBody> }): Promise<z.infer<typeof SweepResult>> {
    const expected = process.env.AGGREGATOR_ADMIN_TOKEN;
    if (!expected) return { ok: false, rejected: "sweep-disabled" };
    if (!tokenEq(input.body.token, expected)) return { ok: false, rejected: "unauthorized" };
    const report = await sweepQuarantine(this.db, { dryRun: !input.body.apply });
    return { ok: true, report };
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
}
