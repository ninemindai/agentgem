// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem.stream.controller.ts
//
// The two prepared-then-streamed gem SSE routes, on the AgentBack `streamOf:`
// dispatch (were raw handlers gemRunStream.ts / gemVerifyStream.ts). Tracking-free
// (no ReportRegistry, no foreground guard — matching the raw handlers): a prepared
// opaque id resolves a run/verify spec, an agent runs, per-event progress streams,
// then `done`. Both share the push->pull `pump` bridge (sse/pump.ts). Business
// failures (unknown/expired id, missing task) stay `failed` events, not 422s.
//
// The POST prepare steps (/api/gem/run/prepare, /api/gem/verify/prepare) stay in
// gem.controller.ts — untouched.
import { z } from "zod";
import { api, get } from "@agentback/openapi";
import { runGemWithAgent, hasTestConnectFn, resolveRun, resolveOrFetchAdapter, AGENT_ADAPTERS, verifyGemRun, contractToExpectations, appendVerification, consumeVerify, verifyGemAcrossAgents, type GemExpectations } from "@agentgem/run";
import { pump } from "./sse/pump.js";
import { GemRunStreamQuery, RunEvent, GemVerifyStreamQuery, VerifyEvent } from "./gem.stream.schema.js";

@api({ basePath: "/api" })
export class GemStreamController {
  // GET /api/gem/run/stream — run an already-prepared Gem with a local ACP agent
  // (materializing → running → per-tool + token deltas → done). runId comes from
  // POST /api/gem/run/prepare; the client only ever holds the opaque id.
  @get("/gem/run/stream", { query: GemRunStreamQuery, streamOf: RunEvent })
  async *run(input: {
    query: z.infer<typeof GemRunStreamQuery>;
  }): AsyncGenerator<z.infer<typeof RunEvent>> {
    const { runId, task, expectText } = input.query;
    const expectTools = input.query.expectTools
      ? input.query.expectTools.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    yield* pump<z.infer<typeof RunEvent>>(async (emit) => {
      try {
        const reg = resolveRun(runId);
        if (!reg) { emit({ type: "failed", message: "unknown or expired runId — prepare the run again" }); return; }
        const contract = reg.meta?.contract;
        const resolvedTask = task || contract?.task || "";
        if (!resolvedTask) { emit({ type: "failed", message: "missing task (no task param and the Gem carries no contract)" }); return; }

        // Resolve the adapter (fetching on demand), streaming a phase so a one-time
        // download shows progress instead of a hang.
        const adapter = AGENT_ADAPTERS[reg.agent];
        const command = hasTestConnectFn()
          ? [adapter.bin]
          : await resolveOrFetchAdapter(adapter, {
              onFetch: () => emit({ type: "phase", phase: "preparing-adapter", agent: reg.agent, pkg: adapter.pkg }),
            });
        emit({ type: "phase", phase: "running", agent: reg.agent });
        const run = await runGemWithAgent({
          dir: reg.dir,
          task: resolvedTask,
          descriptor: { id: adapter.id, name: adapter.name, command },
          onToolCall: (t) => emit({ type: "tool", tool: t }),
          onDelta: (c) => emit({ type: "delta", text: c }),
        });
        // Explicit query expectations replace the contract's entirely (no per-field mixing).
        const queryExpectations: GemExpectations | undefined =
          expectTools || expectText ? { expectTools, expectText } : undefined;
        const expectations = queryExpectations ?? (contract ? contractToExpectations(contract) : undefined);
        const contractApplied = queryExpectations === undefined && contract !== undefined;
        const verification = expectations ? verifyGemRun(run, expectations) : undefined;
        if (verification) {
          appendVerification({
            gemName: reg.meta?.gemName,
            gemDigest: reg.meta?.gemDigest,
            agent: reg.agent,
            adapterVersion: adapter.version,
            contractApplied,
            run: { ok: run.ok, toolCalls: run.ok ? run.result.toolCalls.length : 0 },
            verification,
          });
        }
        emit({ type: "done", result: { runId, agent: reg.agent, run, verification, contractApplied } });
      } catch (err) {
        emit({ type: "failed", message: (err as Error)?.message ?? String(err) });
      }
    });
  }

  // GET /api/gem/verify/stream — stream a prepared cross-agent matrix. Every
  // per-agent event is tagged with `agent`; per-agent problems are `verdict`s
  // (failures are data), so the stream ends in `done` unless the verifyId is
  // unknown or the orchestrator throws before any run.
  @get("/gem/verify/stream", { query: GemVerifyStreamQuery, streamOf: VerifyEvent })
  async *verify(input: {
    query: z.infer<typeof GemVerifyStreamQuery>;
  }): AsyncGenerator<z.infer<typeof VerifyEvent>> {
    const { verifyId } = input.query;
    yield* pump<z.infer<typeof VerifyEvent>>(async (emit) => {
      try {
        const spec = consumeVerify(verifyId);
        if (!spec) { emit({ type: "failed", message: "unknown or expired verifyId — prepare the verify again" }); return; }
        const verdicts = await verifyGemAcrossAgents({
          gem: spec.gem,
          baseDir: spec.baseDir,
          roster: spec.roster,
          fetch: spec.fetch,
          gemDigest: spec.gemDigest,
          onAgentStart: (agent) => emit({ type: "agent-start", agent }),
          onToolCall: (agent, t) => emit({ type: "tool", agent, tool: t }),
          onDelta: (agent, text) => emit({ type: "delta", agent, text }),
          onVerdict: (v) => emit({ type: "verdict", verdict: v }),
        });
        emit({ type: "done", verdicts, gemName: spec.gemName, gemDigest: spec.gemDigest });
      } catch (err) {
        emit({ type: "failed", message: (err as Error)?.message ?? String(err) });
      }
    });
  }
}
