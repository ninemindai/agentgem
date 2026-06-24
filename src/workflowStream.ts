// src/workflowStream.ts
//
// SSE endpoint for the workflow analysis. agentgem's decorator framework returns
// a single JSON body, so streaming progress (scan → agent token stream → done)
// is served by a raw Express handler registered on `server.expressApp`. The
// non-streaming POST /api/workflow/analyze stays for programmatic/test callers.
import { introspectProject } from "./gem/introspect.js";
import { resolveDirs, resolveProject } from "./resolveDir.js";
import { claudeTranscriptsForCwd, scanWorkflow } from "./gem/workflowScan.js";
import { recommendWorkflow, recommendationToSelection } from "./gem/acpRecommender.js";

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
    const dirs = resolveDirs(dir);
    const project = introspectProject(resolveProject(root));

    send("phase", { phase: "scanning" });
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    const signal = scanWorkflow(paths, project);
    send("phase", { phase: "scanned", transcripts: paths.length, sessions: signal.sessions.scanned });

    send("phase", { phase: "thinking" });
    const { recommendation, degraded } = await recommendWorkflow(signal, project, {
      onDelta: (chunk) => send("delta", { text: chunk }),
    });

    send("phase", { phase: "validating" });
    const selection = recommendationToSelection(recommendation);
    send("done", {
      recommendation,
      selection,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes, gaps: recommendation.gaps },
      degraded,
    });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
