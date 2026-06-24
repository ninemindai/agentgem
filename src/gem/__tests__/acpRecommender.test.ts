// src/gem/__tests__/acpRecommender.test.ts
import { describe, it, expect } from "vitest";
import {
  recommendationToSelection, deterministicRecommendation, validateRecommendation,
  recommendWorkflow, type AcpConnectFn,
} from "../acpRecommender.js";
import type { WorkflowSignal } from "../workflowScan.js";
import type { ProjectInventory } from "../types.js";

const ROOT = "/Users/me/work/app";
const inventory: ProjectInventory = {
  root: ROOT, name: "app",
  skills: [{ type: "skill", name: "qa", source: "project", content: "x" }],
  mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {} }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", config: { hooks: [] }, source: "project" }],
};
const signal: WorkflowSignal = {
  root: ROOT, flavor: "claude",
  sessions: { scanned: 3, firstMs: 1, lastMs: 2, spanDays: 1 },
  artifacts: [
    { type: "skill", name: "qa", root: ROOT, invocations: 5, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "context7", root: ROOT, invocations: 4, sessionsUsedIn: 2, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "unusedsrv", root: ROOT, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high" },
    { type: "instructions", name: "CLAUDE.md", root: ROOT, invocations: 3, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "low" },
  ],
  unresolved: [{ name: "playwright", kind: "mcp_server", count: 9 }],
  coOccurrence: [], notes: [],
};

describe("deterministicRecommendation", () => {
  it("includes high-confidence used artifacts, excludes the unused one", () => {
    const rec = deterministicRecommendation(signal);
    expect(rec.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
    expect(rec.exclude.map((i) => i.name)).toContain("unusedsrv");
    expect(rec.includeInstructions).toBe(true);
    expect(rec.gaps).toContain("playwright");
    expect(rec.root).toBe(ROOT);
  });
});

describe("recommendationToSelection", () => {
  it("maps to a project-namespaced GemSelection with instructions as a boolean", () => {
    const rec = deterministicRecommendation(signal);
    const sel = recommendationToSelection(rec) as any;
    expect(sel.projects[ROOT].skills).toEqual(["qa"]);
    expect(sel.projects[ROOT].mcpServers).toEqual(["context7"]);
    expect(sel.projects[ROOT].includeInstructions).toBe(true);
    expect("instructions" in sel.projects[ROOT]).toBe(false);
  });
});

describe("validateRecommendation", () => {
  it("drops hallucinated names not in the inventory", () => {
    const rec = validateRecommendation(
      { name: "G", description: "d", include: [{ type: "skill", name: "qa", reason: "used" }, { type: "skill", name: "ghost", reason: "made up" }], confidence: "high" },
      inventory, signal,
    );
    expect(rec.include.map((i) => i.name)).toEqual(["qa"]);
    expect(rec.root).toBe(ROOT);
  });

  it("falls back to deterministic when raw is junk", () => {
    const rec = validateRecommendation("not json at all", inventory, signal);
    expect(rec.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
  });
});

function fakeConnect(canned: string | (() => Promise<string>)): AcpConnectFn {
  return async () => ({
    ctx: {
      async open(_cwd: string) {
        let mode = "default";
        return {
          async setMode(m: string) { mode = m; },
          async promptText(_t: string) {
            if (mode !== "plan") throw new Error(`expected plan mode, got ${mode}`);
            return typeof canned === "function" ? canned() : canned;
          },
          dispose() {},
        };
      },
    },
    close() {},
  });
}

describe("recommendWorkflow", () => {
  it("parses the agent's JSON, validating against the inventory", async () => {
    const canned = JSON.stringify({ name: "QA Kit", description: "qa flow", include: [{ type: "skill", name: "qa", reason: "core" }], confidence: "high" });
    const { recommendation, degraded } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(recommendation.name).toBe("QA Kit");
    expect(recommendation.include.map((i) => i.name)).toEqual(["qa"]);
  });

  it("drops hallucinated names even from a live agent response", async () => {
    const canned = JSON.stringify({ name: "X", description: "d", include: [{ type: "skill", name: "ghost", reason: "nope" }], confidence: "high" });
    const { recommendation } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(canned) });
    expect(recommendation.include.find((i) => i.name === "ghost")).toBeUndefined();
  });

  it("degrades to the deterministic recommendation on agent error", async () => {
    const { recommendation, degraded } = await recommendWorkflow(signal, inventory, {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(degraded).toBe(true);
    expect(recommendation.include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
  });

  it("degrades on timeout", async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r("{}"), 50));
    const { degraded } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(slow), timeoutMs: 5 });
    expect(degraded).toBe(true);
  });

  it("forwards agent chunks to onDelta", async () => {
    const chunks: string[] = [];
    const streamingConnect: AcpConnectFn = async () => ({
      ctx: { async open() { return {
        async setMode() {},
        async promptText(_t: string, onDelta?: (c: string) => void) { onDelta?.('{"name":"X","desc'); onDelta?.('ription":"d","include":[{"type":"skill","name":"qa","reason":"r"}],"confidence":"high"}'); return '{"name":"X","description":"d","include":[{"type":"skill","name":"qa","reason":"r"}],"confidence":"high"}'; },
        dispose() {},
      }; } },
      close() {},
    });
    const { recommendation } = await recommendWorkflow(signal, inventory, { connectFn: streamingConnect, onDelta: (c) => chunks.push(c) });
    expect(chunks.length).toBe(2);
    expect(recommendation.include.map((i) => i.name)).toEqual(["qa"]);
  });
});
