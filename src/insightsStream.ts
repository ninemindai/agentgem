// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsStream.ts
//
// SSE transport wrapper over computeInsights (src/insightsCore.ts). All compute
// + caching lives in the core so the endpoint and the background warmer stay in
// sync. Registered raw on expressApp because the decorator framework only
// returns single JSON bodies.
import { computeInsights } from "./insightsCore.js";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export async function streamInsights(req: SseReq, res: SseRes): Promise<void> {
  const root = typeof req.query.root === "string" ? req.query.root : "";
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;
  const fresh = req.query.fresh === "1";   // bypass the cache (Re-run)

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
    if (!root) { send("failed", { message: "missing root" }); return; }
    const { payload, cached, updatedAt } = await computeInsights(root, {
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
