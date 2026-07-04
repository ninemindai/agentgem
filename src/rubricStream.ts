// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/rubricStream.ts
//
// SSE endpoint for evaluating one rubric at a scope. Phase 1 factors are cheap
// (pure spine scan), so this streams start → done|failed without the foreground
// agent guard the insights route needs. Phase 2 (LLM criteria) will add per-factor
// progress deltas and the foreground guard.
import { computeRubric, resolveRubric } from "./rubricCore.js";
import { scopeAllowed, type RubricScope } from "@agentgem/insight";
import { createLogger } from "@agentgem/base";

const log = createLogger("rubric");

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

function str(q: unknown): string | undefined {
  return typeof q === "string" && q ? q : undefined;
}

// Parse ?scope=&root=&sessionId= into a RubricScope, or an error message.
function parseScope(q: Record<string, unknown>): RubricScope | { error: string } {
  const kind = str(q.scope) ?? "project";
  if (kind === "all") return { kind: "all" };
  const root = str(q.root);
  if (kind === "project") {
    if (!root) return { error: "project scope requires ?root=" };
    return { kind: "project", root };
  }
  if (kind === "session") {
    const sessionId = str(q.sessionId);
    if (!root || !sessionId) return { error: "session scope requires ?root= and ?sessionId=" };
    return { kind: "session", root, sessionId };
  }
  return { error: `unknown scope: ${kind}` };
}

export async function streamRubric(req: SseReq, res: SseRes): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const dir = str(req.query.dir);
    const id = str(req.query.rubric);
    if (!id) { send("failed", { message: "missing ?rubric=<id>" }); return; }

    const rubric = resolveRubric(id, dir);
    if (!rubric) { send("failed", { message: `unknown rubric: ${id}` }); return; }

    const scope = parseScope(req.query);
    if ("error" in scope) { send("failed", { message: scope.error }); return; }

    // Hard rule: an aggregate-only rubric can't run at session scope (§Scope).
    if (!scopeAllowed(rubric, scope.kind)) {
      send("failed", { message: `rubric "${rubric.id}" is aggregate-only and cannot run at scope "${scope.kind}"` });
      return;
    }

    send("start", { rubric: rubric.id, title: rubric.title, target: rubric.target, scope: scope.kind });
    const fresh = str(req.query.refresh) === "true";   // ?refresh=true bypasses the cache
    const { payload, cached, updatedAt } = await computeRubric(rubric, scope, { dir, force: fresh });
    send("done", { report: payload, cached, updatedAt });
  } catch (err) {
    log.warn("streamRubric failed: %s", (err as Error)?.message ?? err);
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
