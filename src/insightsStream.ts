// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/insightsStream.ts
//
// SSE endpoint for the personal session-insights report. Mirrors
// workflowStream.ts: scan a project's transcripts → judge each session with the
// ACP agent (streaming its tokens) → synthesize the cross-session report. Thin
// I/O glue; all testable logic lives in @agentgem/insight (facets, judgeSessions,
// synthesizeInsights). Registered raw on expressApp because the decorator
// framework only returns single JSON bodies.
import { introspectConfig, introspectProject } from "@agentgem/capture";
import { resolveDirs, resolveProject } from "@agentgem/model";
import { claudeTranscriptsForCwd, allClaudeTranscripts, scanWorkflow } from "@agentgem/insight";
import { judgeSessions, synthesizeInsights, narrateInsights } from "@agentgem/insight";
import { insightsToken, readInsightsCache, writeInsightsCache } from "@agentgem/insight";

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
    const dirs = resolveDirs(dir);
    // root === "*" → cross-project: judge the most-recent sessions across ALL
    // projects (the agent cap bounds it). Inventory is irrelevant to insights
    // (only mission hints are used), so the all-projects path skips introspection.
    const allProjects = root === "*";
    const scanInv = allProjects
      ? { project: { root: "*", name: "All projects", skills: [], mcpServers: [], hooks: [], instructions: [] } }
      : (() => {
          const project = introspectProject(resolveProject(root));
          const globalInv = introspectConfig(dirs);
          return { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };
        })();

    send("phase", { phase: "scanning" });
    const paths = allProjects ? allClaudeTranscripts(dirs.claudeDir) : claudeTranscriptsForCwd(dirs.claudeDir, root);

    // Cache hit (unless Re-run): the report is two agent passes, so serve the
    // prior result instantly. Token invalidates when a session is added/updated.
    const token = insightsToken(paths);
    if (!fresh) {
      const cached = readInsightsCache(root, token);
      if (cached) { send("done", { ...(cached as object), cached: true }); return; }
    }

    const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
    send("phase", { phase: "scanned", transcripts: paths.length, sessions: signal.sessions.scanned });

    send("phase", { phase: "judging" });
    const { facets, degraded: judgeDegraded } = await judgeSessions(signal, { onDelta: (chunk) => send("delta", { text: chunk }) });

    send("phase", { phase: "synthesizing" });
    const report = synthesizeInsights(facets);

    // Upgrade the deterministic narrative with the agent's cross-session prose.
    send("phase", { phase: "narrating" });
    const narr = await narrateInsights(facets, report.narrative, { onDelta: (chunk) => send("delta", { text: chunk }) });
    report.narrative = narr.narrative;

    const payload = {
      report,
      facets,
      degraded: judgeDegraded || narr.degraded,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
    };
    if (!payload.degraded) writeInsightsCache(root, token, payload, Date.now());   // don't cache fallbacks
    send("done", { ...payload, cached: false });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
