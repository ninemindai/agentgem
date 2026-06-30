import { z } from "zod";
import { api, post } from "@agentback/openapi";
import { postShare } from "./gem/shareClient.js";

const Counts = z.object({
  breadth: z.number().int().nonnegative(),
  battleTested: z.number().int().nonnegative(),
  portable: z.number().int().nonnegative(),
}).strict();
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("certificate"), counts: Counts, generatedAtMs: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("gem"), name: z.string().min(1).max(120), provenance: z.string().max(200), generatedAtMs: z.number().int().nonnegative() }).strict(),
]);
const Result = z.object({ id: z.string(), url: z.string() });

// Same-origin endpoint the console calls. Forwards to the hosted aggregator (the app.agentgem.ai
// default, overridable via AGENTGEM_AGGREGATOR_URL). Browser stays same-origin.
@api({ basePath: "/api/share" })
export class ShareProxyController {
  @post("/", { body: Body, response: Result })
  async create(input: { body: z.infer<typeof Body> }): Promise<z.infer<typeof Result>> {
    const r = await postShare({ body: input.body });
    if ("skipped" in r) throw new Error("sharing is disabled (AGENTGEM_AGGREGATOR_URL set empty)");
    return r;
  }
}
