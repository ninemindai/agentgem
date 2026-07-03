// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gemVerifyStream.ts
//
// SSE endpoint for the streaming cross-agent matrix: GET streams a prepared verify
// (POST /api/gem/verify/prepare returned the opaque verifyId). Same split and the
// same duck-typed Express glue as gemRunStream.ts — the client never holds paths or
// the gem body. Every per-agent event is tagged with `agent`; per-agent problems
// are `verdict`s (failures are data), so the stream ends in `done` unless the
// verifyId is unknown or the orchestrator itself throws before any run.
import { resolveVerify, verifyGemAcrossAgents } from "@agentgem/run";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function streamGemVerify(req: SseReq, res: SseRes): Promise<void> {
  const verifyId = str(req.query.verifyId);
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
    const spec = resolveVerify(verifyId);
    if (!spec) { send("failed", { message: "unknown or expired verifyId — prepare the verify again" }); return; }
    const verdicts = await verifyGemAcrossAgents({
      gem: spec.gem,
      baseDir: spec.baseDir,
      roster: spec.roster,
      fetch: spec.fetch,
      gemDigest: spec.gemDigest,
      onAgentStart: (agent) => send("agent-start", { agent }),
      onToolCall: (agent, t) => send("tool", { agent, ...t }),
      onDelta: (agent, text) => send("delta", { agent, text }),
      onVerdict: (v) => send("verdict", v),
    });
    send("done", { verdicts, gemName: spec.gemName, gemDigest: spec.gemDigest });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
