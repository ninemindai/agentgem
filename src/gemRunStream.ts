// src/gemRunStream.ts
//
// SSE endpoint for running a Gem with a local ACP coding agent. Mirrors
// workflowStream.ts: the decorator framework returns a single JSON body, so the
// live progress stream (materializing → running → agent tool/token deltas → done)
// is served by a raw Express handler. The POST /api/gem/run route stays for
// programmatic/test callers.
import { join } from "node:path";
import { readGemArchive } from "./gem/archive.js";
import { readArchiveDir } from "./gem/archiveFs.js";
import { materializeAndRunGem, type AgentId } from "./gem/runGem.js";
import { agentgemHome } from "./resolveDir.js";

interface SseReq { query: Record<string, unknown> }
interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export async function streamGemRun(req: SseReq, res: SseRes): Promise<void> {
  const archivePath = str(req.query.archivePath);
  const task = str(req.query.task);
  const dirParam = str(req.query.dir);
  const agent = (str(req.query.agent) || "claude") as AgentId;
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
    if (!archivePath || !task) { send("failed", { message: "missing archivePath or task" }); return; }
    const gem = readGemArchive(readArchiveDir(archivePath));
    const dir = dirParam || join(agentgemHome(), ".agentgem", "runs", gem.name.replace(/[^A-Za-z0-9._-]/g, "-"));
    const expectations = expectTools || expectText ? { expectTools, expectText } : undefined;

    send("phase", { phase: "materializing", dir, agent });
    send("phase", { phase: "running" });
    const out = await materializeAndRunGem({
      gem, dir, task, agent, expectations,
      onToolCall: (t) => send("tool", t),
      onDelta: (c) => send("delta", { text: c }),
    });
    send("done", { dir, agent: out.agent, materialized: out.materialized, run: out.run, verification: out.verification });
  } catch (err) {
    send("failed", { message: (err as Error)?.message ?? String(err) });
  } finally {
    res.end();
  }
}
