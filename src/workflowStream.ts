// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflowStream.ts
//
// SSE endpoint for the workflow analysis. agentgem's decorator framework returns
// a single JSON body, so streaming progress (scan → agent token stream → done)
// is served by a raw Express handler registered on `server.expressApp`. The
// non-streaming POST /api/workflow/analyze stays for programmatic/test callers.
import { computeWorkflowAnalysis } from "./workflowCore.js";

// Minimal structural types for the Express req/res we use — avoids a hard
// dependency on @types/express (expressApp's handler is duck-typed).
interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export async function streamWorkflowAnalyze(req: SseReq, res: SseRes): Promise<void> {
  const root = typeof req.query.root === "string" ? req.query.root : "";
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const fresh = req.query.fresh === "1";   // bypass the cache (Re-analyze)

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering so events flush immediately
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    if (!root) { send("failed", { message: "missing root" }); return; }
    const { payload, cached, updatedAt } = await computeWorkflowAnalysis(root, {
      dir, force: fresh,
      progress: {
        onPhase: (phase, extra) => send("phase", { phase, ...(extra ?? {}) }),
        onDelta: (text) => send("delta", { text }),
      },
    });
    send("done", { ...payload, cached, updatedAt });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
