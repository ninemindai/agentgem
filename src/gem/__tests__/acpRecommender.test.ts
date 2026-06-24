// src/gem/__tests__/acpRecommender.test.ts
import { describe, it, expect } from "vitest";
import {
  recommendationToSelection, deterministicAnalysis, validateAnalysis,
  recommendWorkflow, type AcpConnectFn,
} from "../acpRecommender.js";
import type { WorkflowSignal } from "../workflowScan.js";
import type { ProjectInventory } from "../types.js";

const ROOT = "/Users/me/work/app";
const inventory: ProjectInventory = {
  root: ROOT, name: "app",
  skills: [
    { type: "skill", name: "qa", source: "project", content: "x" },
    { type: "skill", name: "diagram", source: "project", content: "x" },
  ],
  mcpServers: [
    { type: "mcp_server", name: "context7", transport: "stdio", config: {} },
    { type: "mcp_server", name: "playwright", transport: "stdio", config: {} },
  ],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", config: { hooks: [] }, source: "project" }],
};
const signal: WorkflowSignal = {
  root: ROOT, flavor: "claude",
  sessions: { scanned: 3, firstMs: 1, lastMs: 2, spanDays: 1 },
  artifacts: [
    { type: "skill", name: "qa", root: ROOT, invocations: 5, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "context7", root: ROOT, invocations: 4, sessionsUsedIn: 2, lastUsedMs: 2, confidence: "high" },
    { type: "mcp_server", name: "playwright", root: ROOT, invocations: 0, sessionsUsedIn: 0, lastUsedMs: null, confidence: "high" },
    { type: "instructions", name: "CLAUDE.md", root: ROOT, invocations: 3, sessionsUsedIn: 3, lastUsedMs: 2, confidence: "low" },
  ],
  unresolved: [{ name: "github", kind: "mcp_server", count: 9 }],
  coOccurrence: [], shapes: [{ artifacts: ["qa", "context7"], sessions: 2 }], notes: [],
};

describe("deterministicAnalysis", () => {
  it("returns one candidate of high-confidence used artifacts + project gaps", () => {
    const a = deterministicAnalysis(signal);
    expect(a.candidates).toHaveLength(1);
    expect(a.candidates[0].include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
    expect(a.candidates[0].includeInstructions).toBe(true);
    expect(a.candidates[0].root).toBe(ROOT);
    expect(a.gaps).toContain("github");
  });
});

describe("recommendationToSelection", () => {
  it("maps a candidate to a project-namespaced GemSelection with instructions as a boolean", () => {
    const c = deterministicAnalysis(signal).candidates[0];
    const sel = recommendationToSelection(c) as any;
    expect(sel.projects[ROOT].skills).toEqual(["qa"]);
    expect(sel.projects[ROOT].mcpServers).toEqual(["context7"]);
    expect(sel.projects[ROOT].includeInstructions).toBe(true);
    expect("instructions" in sel.projects[ROOT]).toBe(false);
  });
});

describe("validateAnalysis", () => {
  it("keeps multiple candidates and drops hallucinated names per candidate", () => {
    const a = validateAnalysis({
      candidates: [
        { name: "QA", description: "qa", include: [{ type: "skill", name: "qa", reason: "used" }, { type: "skill", name: "ghost", reason: "nope" }], confidence: "high" },
        { name: "Diagrams", description: "d", include: [{ type: "skill", name: "diagram", reason: "used" }], confidence: "medium" },
      ],
      gaps: ["github"],
    }, inventory, signal);
    expect(a.candidates).toHaveLength(2);
    expect(a.candidates[0].include.map((i) => i.name)).toEqual(["qa"]);   // ghost dropped
    expect(a.candidates[1].include.map((i) => i.name)).toEqual(["diagram"]);
    expect(a.gaps).toContain("github");
  });

  it("drops candidates with no surviving includes", () => {
    const a = validateAnalysis({
      candidates: [{ name: "X", description: "d", include: [{ type: "skill", name: "ghost", reason: "nope" }], confidence: "high" }],
    }, inventory, signal);
    // no valid candidate -> deterministic fallback (one candidate)
    expect(a.candidates).toHaveLength(1);
    expect(a.candidates[0].include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
  });

  it("falls back to deterministic when raw is junk", () => {
    const a = validateAnalysis("not json at all", inventory, signal);
    expect(a.candidates[0].include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
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
  it("parses multiple candidates, validating each against the inventory", async () => {
    const canned = JSON.stringify({
      candidates: [
        { name: "QA Kit", description: "qa flow", include: [{ type: "skill", name: "qa", reason: "core" }], confidence: "high" },
        { name: "Diagram Kit", description: "diagram flow", include: [{ type: "skill", name: "diagram", reason: "core" }], confidence: "medium" },
      ],
      gaps: [],
    });
    const { analysis, degraded } = await recommendWorkflow(signal, inventory, { connectFn: fakeConnect(canned) });
    expect(degraded).toBe(false);
    expect(analysis.candidates.map((c) => c.name)).toEqual(["QA Kit", "Diagram Kit"]);
  });

  it("degrades to the deterministic analysis on agent error", async () => {
    const { analysis, degraded } = await recommendWorkflow(signal, inventory, {
      connectFn: async () => { throw new Error("no binary"); },
    });
    expect(degraded).toBe(true);
    expect(analysis.candidates[0].include.map((i) => i.name).sort()).toEqual(["context7", "qa"]);
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
        async promptText(_t: string, onDelta?: (c: string) => void) {
          onDelta?.('{"candidates":[{"name":"X","des');
          onDelta?.('cription":"d","include":[{"type":"skill","name":"qa","reason":"r"}],"confidence":"high"}]}');
          return '{"candidates":[{"name":"X","description":"d","include":[{"type":"skill","name":"qa","reason":"r"}],"confidence":"high"}]}';
        },
        dispose() {},
      }; } },
      close() {},
    });
    const { analysis } = await recommendWorkflow(signal, inventory, { connectFn: streamingConnect, onDelta: (c) => chunks.push(c) });
    expect(chunks.length).toBe(2);
    expect(analysis.candidates[0].include.map((i) => i.name)).toEqual(["qa"]);
  });
});
