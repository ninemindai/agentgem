import { z } from "zod";
import { api, get, post, AgentError } from "@agentback/openapi";
import { inject } from "@agentback/core";
import { DrizzleBindings } from "@agentback/drizzle";
import type { AppDb } from "./aggregator/schema.js";
import { createShareCard, getShareCard } from "./share/shareStore.js";

const Counts = z.object({
  breadth: z.number().int().nonnegative(),
  battleTested: z.number().int().nonnegative(),
  portable: z.number().int().nonnegative(),
}).strict();
const CreateBody = z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict();
const CreateResult = z.object({ id: z.string(), url: z.string() });
const ReadQuery = z.object({ id: z.string() });
const ReadResult = z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number(), createdAtMs: z.number() });

@api({ basePath: "/api/aggregator/share" })
export class ShareController {
  constructor(@inject(DrizzleBindings.CLIENT) private db: AppDb) {}

  @post("/", { body: CreateBody, response: CreateResult })
  async create(input: { body: z.infer<typeof CreateBody> }): Promise<z.infer<typeof CreateResult>> {
    const body = CreateBody.parse(input.body); // belt-and-suspenders: reject extras/negatives
    return createShareCard(this.db, body);
  }

  @get("/", { query: ReadQuery, response: ReadResult })
  async read(input: { query: z.infer<typeof ReadQuery> }): Promise<z.infer<typeof ReadResult>> {
    const rec = await getShareCard(this.db, input.query.id);
    // A missing card is a clean 404, not a 500 — a plain Error would be redacted to a generic 500,
    // and the Worker can't then tell "no such card" from a real backend fault. AgentError carries
    // the status + a stable code through buildErrorEnvelope.
    if (!rec) throw new AgentError("share card not found", { status: 404, code: "share_not_found", retryable: false });
    return rec as z.infer<typeof ReadResult>;
  }
}
