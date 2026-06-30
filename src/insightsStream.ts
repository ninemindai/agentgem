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
import { claudeTranscriptsForCwd, scanWorkflow } from "@agentgem/insight";
import { judgeSessions, synthesizeInsights } from "@agentgem/insight";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export async function streamInsights(req: SseReq, res: SseRes): Promise<void> {
  const root = typeof req.query.root === "string" ? req.query.root : "";
  const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;

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
    const project = introspectProject(resolveProject(root));
    const globalInv = introspectConfig(dirs);
    const scanInv = { project, global: { skills: globalInv.skills, mcpServers: globalInv.mcpServers, hooks: globalInv.hooks } };

    send("phase", { phase: "scanning" });
    const paths = claudeTranscriptsForCwd(dirs.claudeDir, root);
    const signal = scanWorkflow(paths, scanInv, { retainSequences: true });
    send("phase", { phase: "scanned", transcripts: paths.length, sessions: signal.sessions.scanned });

    send("phase", { phase: "judging" });
    const { facets, degraded } = await judgeSessions(signal, { onDelta: (chunk) => send("delta", { text: chunk }) });

    send("phase", { phase: "synthesizing" });
    const report = synthesizeInsights(facets);
    send("done", {
      report,
      facets,
      degraded,
      signalSummary: { sessionsScanned: signal.sessions.scanned, spanDays: signal.sessions.spanDays, notes: signal.notes },
    });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
