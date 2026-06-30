// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/workflowStream.ts
//
// SSE endpoint for the workflow analysis. agentgem's decorator framework returns
// a single JSON body, so streaming progress (scan → agent token stream → done)
// is served by a raw Express handler registered on `server.expressApp`. The
// non-streaming POST /api/workflow/analyze stays for programmatic/test callers.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import { claudeTranscriptsForCwd, scanWorkflow } from "@agentgem/insight";
import { recommendWorkflow, recommendationToSelection } from "@agentgem/insight";
import { distillWorkflow } from "@agentgem/insight";
import { extractReflections } from "@agentgem/insight";
import { writeReflections } from "@agentgem/insight";
import { transcriptToken, readAnalysisCache, writeAnalysisCache } from "@agentgem/insight";

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
    const dirs = resolveDirs(dir);
    const project = introspectProject(resolveProject(root));
    const globalInv = introspectConfig(dirs);   // global + plugin artifacts
    const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

    send("phase", { phase: "scanning" });
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);

    // Cache hit (unless Re-analyze): return the prior result instantly so the
    // user can revisit a project to pick another candidate without re-running
    // the agent. Token invalidates when sessions are added/updated.
    const token = transcriptToken(paths);
    if (!fresh) {
      const cached = readAnalysisCache(root, token);
      if (cached) { send("done", { ...(cached as object), cached: true }); return; }
    }

    const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
    send("phase", { phase: "scanned", transcripts: paths.length, sessions: signal.sessions.scanned });

    send("phase", { phase: "thinking" });
    // Selective recommendation streams its tokens; distillation runs concurrently
    // but SILENT — two delta streams would interleave and garble the display
    // (proposal §5). Both never throw, so wall-clock is max(...), not the sum.
    const [{ analysis, degraded }, distill] = await Promise.all([
      recommendWorkflow(signal, scanInv, { onDelta: (chunk) => send("delta", { text: chunk }) }),
      distillWorkflow(signal, scanInv),
    ]);

    send("phase", { phase: "validating" });
    const reflections = extractReflections(signal);
    writeReflections(reflections, root);   // best-effort; ignore the path
    const gaps = [...analysis.gaps, ...reflections.filter((r) => r.importance === "high").map((r) => r.detail)];
    const candidates = analysis.candidates.map((c) => ({ ...c, selection: recommendationToSelection(c) }));
    const anyDegraded = degraded || distill.degraded;
    const payload = {
      candidates,
      gaps,
      distilled: distill.distilled,
      reflections,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
      degraded: anyDegraded,
    };
    if (!anyDegraded) writeAnalysisCache(root, token, payload, Date.now());   // don't cache fallbacks
    send("done", { ...payload, cached: false });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
