// src/aggregator.controller.ts
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "./aggregator/schema.js";
import { ingestAttestation } from "./aggregator/ingest.js";
import { popularity, coOccurrence } from "./aggregator/aggregates.js";
import type { UsageAttestation } from "./gem/attestation.js";

// Loose body schema — the real gate is the core's verifyAttestation (ed25519 + consistency).
const IngestBody = z.object({ producer: z.object({ publicKey: z.string() }).loose(), signature: z.string(), gem: z.object({ digest: z.string() }).loose() }).loose();
const IngestResult = z.union([
  z.object({ accepted: z.literal(true), id: z.string(), publicIngredients: z.number(), privateCount: z.number(), idempotent: z.boolean() }),
  z.object({ accepted: z.literal(false), rejected: z.string() }),
]);
const PopQuery = z.object({ kind: z.string().optional(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const PopResult = z.array(z.object({ id: z.string(), kind: z.string(), producers: z.number(), invocations: z.number(), sessions: z.number() }));
const CoQuery = z.object({ id: z.string(), limit: z.coerce.number().optional() }); // NOTE: no `k`
const CoResult = z.array(z.object({ id: z.string(), producers: z.number() }));

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
}
