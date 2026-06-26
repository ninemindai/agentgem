// src/gemRunStream.ts
//
// SSE endpoint for running an already-prepared Gem with a local ACP coding agent.
// This is step 2 of the streaming flow: POST /api/gem/run/prepare materializes the
// Gem and returns an opaque runId; this GET streams the agent run for that runId
// (materializing → running → per-tool + token deltas → done). Splitting prepare
// (POST, carries the selection) from stream (GET, simple query params) lets the UI
// use native EventSource while keeping the run dir off the wire — the client only
// ever holds the opaque id, never a path it could redirect the agent to.
import { runGemWithAgent } from "./gem/acpRun.js";
import { resolveRun, AGENT_ADAPTERS } from "./gem/runGem.js";
import { verifyGemRun, type GemExpectations } from "./gem/gemVerify.js";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function streamGemRun(req: SseReq, res: SseRes): Promise<void> {
  const runId = str(req.query.runId);
  const task = str(req.query.task);
  const expectTools = str(req.query.expectTools)
    ? str(req.query.expectTools).split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const expectText = str(req.query.expectText) || undefined;

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
    const reg = resolveRun(runId);
    if (!reg) { send("failed", { message: "unknown or expired runId — prepare the run again" }); return; }
    if (!task) { send("failed", { message: "missing task" }); return; }

    send("phase", { phase: "running", agent: reg.agent });
    const run = await runGemWithAgent({
      dir: reg.dir,
      task,
      descriptor: AGENT_ADAPTERS[reg.agent].descriptor,
      onToolCall: (t) => send("tool", t),
      onDelta: (c) => send("delta", { text: c }),
    });
    const expectations: GemExpectations | undefined = expectTools || expectText ? { expectTools, expectText } : undefined;
    const verification = expectations ? verifyGemRun(run, expectations) : undefined;
    send("done", { runId, agent: reg.agent, run, verification });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
