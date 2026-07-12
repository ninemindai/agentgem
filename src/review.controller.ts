// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Local console-facing routes that drive the aggregator review-staging flow: build the archive+manifest
// (like GemController.publishSetup) and forward it via the Task 1 sign+forward client
// (src/gem/reviewClient.ts), which signs the review-specific payloads (never catalogSigningPayload).
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { readWorkspace } from "@agentgem/base";
import { readGemArchive } from "@agentgem/archive";
import { exportGem, importGem } from "@agentgem/distribute";
import { loadOrCreateIdentity } from "@agentgem/model";
import type { CatalogManifest } from "@agentgem/aggregator";
import { postReviewRequest, postReviewResubmit, postReviewAction } from "./gem/reviewClient.js";

const ReviewRequestBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), groupId: z.string(), description: z.string().max(4000).optional() });
const ReviewRequestResult = z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() });
const ReviewResubmitBody = z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), requestId: z.string(), description: z.string().max(4000).optional() });
const ReviewActionResult = z.object({ ok: z.boolean(), rejected: z.string().optional() });

// Build the same manifest publishSetup builds (src/gem.controller.ts:620-641), MINUS visibility (a
// staged gem's visibility is decided at approval/publish, not at review submission) and MINUS tags
// (publishSetup takes tags from its request body, which the review routes don't collect).
function buildManifest(b: { workspace: string; scope: string; name?: string; version: string; description?: string }): { manifest: CatalogManifest; archiveBase64: string } {
  const gem = readGemArchive(readWorkspace(b.workspace).files);
  const { bytes } = exportGem(gem, { version: b.version });
  const { meta } = importGem(bytes);
  const manifest: CatalogManifest = {
    gemKey: `${b.scope}/${b.name ?? b.workspace}`, version: b.version,
    description: b.description, grade: gem.grade,
    artifactKinds: [...new Set(gem.artifacts.map((a) => a.type))],
    artifacts: gem.artifacts.map((a) => ({ name: a.name, type: a.type })),
    gemDigest: meta.gemDigest,
  };
  return { manifest, archiveBase64: bytes.toString("base64") };
}

@api({ basePath: "/api/review" })
export class ReviewController {
  @post("/request", { body: ReviewRequestBody, response: ReviewRequestResult })
  async request(input: { body: z.infer<typeof ReviewRequestBody> }): Promise<z.infer<typeof ReviewRequestResult>> {
    const b = input.body;
    const { manifest, archiveBase64 } = buildManifest(b);
    const r = await postReviewRequest({ manifest, archiveBase64, groupId: b.groupId, description: b.description, identity: loadOrCreateIdentity() });
    return r.ok ? { ok: true, requestId: r.requestId } : { ok: false, rejected: r.rejected };
  }

  @post("/resubmit", { body: ReviewResubmitBody, response: ReviewActionResult })
  async resubmit(input: { body: z.infer<typeof ReviewResubmitBody> }): Promise<z.infer<typeof ReviewActionResult>> {
    const b = input.body;
    const { manifest, archiveBase64 } = buildManifest(b);
    const r = await postReviewResubmit({ manifest, archiveBase64, requestId: b.requestId, description: b.description, identity: loadOrCreateIdentity() });
    return r.ok ? { ok: true } : { ok: false, rejected: r.rejected };
  }

  // Signs the reviewer action verb (must match the aggregator's own `reviewActionPayload` usage) and
  // forwards to the matching /review/* aggregator route, returning its JSON verbatim.
  private act(action: string, requestId: string, path: string, extra?: Record<string, unknown>) {
    return postReviewAction({ action, requestId, path, extra, identity: loadOrCreateIdentity() });
  }

  @get("/inbox", { response: z.object({ requests: z.array(z.any()) }) })
  async inbox(): Promise<{ requests: any[] }> { return await this.act("inbox", "", "/review/inbox"); }

  @get("/get", { query: z.object({ requestId: z.string() }), response: z.object({ request: z.any().nullable() }) })
  async getOne(input: { query: { requestId: string } }): Promise<{ request: any }> { return await this.act("get", input.query.requestId, "/review/get"); }

  @post("/message", { body: z.object({ requestId: z.string(), body: z.string().min(1).max(4000) }), response: ReviewActionResult })
  async message(input: { body: { requestId: string; body: string } }): Promise<z.infer<typeof ReviewActionResult>> {
    return await this.act("message:" + input.body.body, input.body.requestId, "/review/message", { body: input.body.body });
  }

  @post("/approve", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() }) })
  async approve(input: { body: { requestId: string } }) { return await this.act("approve", input.body.requestId, "/review/approve"); }

  @post("/changes", { body: z.object({ requestId: z.string() }), response: ReviewActionResult })
  async changes(input: { body: { requestId: string } }) { return await this.act("changes", input.body.requestId, "/review/changes"); }

  @post("/withdraw", { body: z.object({ requestId: z.string() }), response: ReviewActionResult })
  async withdraw(input: { body: { requestId: string } }) { return await this.act("withdraw", input.body.requestId, "/review/withdraw"); }

  @post("/seen", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean() }) })
  async seen(input: { body: { requestId: string } }) { return await this.act("seen", input.body.requestId, "/review/seen"); }
}
