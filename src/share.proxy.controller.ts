// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { z } from "zod";
import { api, post, AgentError } from "@agentback/openapi";
import { postShare } from "./gem/shareClient.js";

// Match the aggregator's own sanitize (strip C0 control chars + trim) so we validate — and
// forward — the SAME value the upstream will store. Without this, a whitespace/control-only
// name passes min(1) here, gets forwarded, and 500s upstream where it trims to "".
const sanitize = (s: string): string => Array.from(s).filter((ch) => ch.charCodeAt(0) >= 0x20).join("").trim();

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

// Same-origin endpoint the console calls. Forwards to the hosted aggregator (the api.agentgem.ai
// default, overridable via AGENTGEM_AGGREGATOR_URL). Browser stays same-origin.
@api({ basePath: "/api/share" })
export class ShareProxyController {
  @post("/", { body: Body, response: Result })
  async create(input: { body: z.infer<typeof Body> }): Promise<z.infer<typeof Result>> {
    // Sanitize a gem name/provenance the same way the aggregator does, and reject a name that
    // reduces to empty with a clean 422 — never forward a request that is destined to 500 upstream.
    const body = input.body.kind === "gem"
      ? { ...input.body, name: sanitize(input.body.name), provenance: sanitize(input.body.provenance) }
      : input.body;
    if (body.kind === "gem" && body.name.length === 0) {
      throw new AgentError("gem name is empty after trimming whitespace/control characters", { status: 422, code: "invalid_body", retryable: false });
    }
    const r = await postShare({ body });
    if ("skipped" in r) throw new AgentError("sharing is disabled (AGENTGEM_AGGREGATOR_URL is set empty)", { status: 503, code: "sharing_disabled", retryable: false });
    return r;
  }
}
