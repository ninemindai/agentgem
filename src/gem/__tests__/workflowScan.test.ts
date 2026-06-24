// src/gem/__tests__/workflowScan.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeTranscriptsForCwd, scanWorkflow } from "../workflowScan.js";
import type { ProjectInventory } from "../types.js";

let claudeDir: string;
const PROJ = "/Users/me/work/app";

beforeAll(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "wfscan-"));
  const projectsDir = join(claudeDir, "projects");
  for (const [folder, cwd, files] of [
    ["enc-a", PROJ, ["s1.jsonl", "s2.jsonl"]],
    ["enc-b", PROJ, ["s3.jsonl"]],
    ["enc-c", "/Users/me/other", ["s4.jsonl"]],
  ] as const) {
    const dir = join(projectsDir, folder);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), JSON.stringify({ type: "summary" }) + "\n" + JSON.stringify({ cwd }) + "\n");
  }
});
afterAll(() => rmSync(claudeDir, { recursive: true, force: true }));

describe("claudeTranscriptsForCwd", () => {
  it("returns every .jsonl whose session cwd matches, across folders", () => {
    const paths = claudeTranscriptsForCwd(claudeDir, PROJ).map((p) => p.split("/").pop()).sort();
    expect(paths).toEqual(["s1.jsonl", "s2.jsonl", "s3.jsonl"]);
  });

  it("returns [] for a missing projects dir", () => {
    expect(claudeTranscriptsForCwd(join(claudeDir, "nope"), PROJ)).toEqual([]);
  });
});

const inventory: ProjectInventory = {
  root: PROJ,
  name: "app",
  skills: [{ type: "skill", name: "qa", source: "project", content: "x" }],
  mcpServers: [{ type: "mcp_server", name: "context7", transport: "stdio", config: {} }],
  instructions: [{ type: "instructions", name: "CLAUDE.md", content: "x" }],
  hooks: [],
};

function assistantToolUse(name: string, input: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
}

describe("scanWorkflow skills + mcp", () => {
  it("counts real tool_use invocations and ignores the system-prompt catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfscan2-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "system", content: 'available: mcp__plugin_context7_context7__query-docs' }),
      assistantToolUse("mcp__plugin_context7_context7__query-docs"),
      assistantToolUse("mcp__plugin_context7_context7__resolve-library-id"),
      assistantToolUse("Skill", { skill: "qa" }),
      assistantToolUse("Bash"),
      assistantToolUse("mcp__plugin_unknownsrv__do"),
    ].join("\n") + "\n");

    const sig = scanWorkflow([file], { project: inventory });
    const byName = Object.fromEntries(sig.artifacts.map((a) => [a.name, a]));
    expect(byName["context7"].invocations).toBe(2);
    expect(byName["context7"].confidence).toBe("high");
    expect(byName["qa"].invocations).toBe(1);
    expect(byName["context7"].sessionsUsedIn).toBe(1);
    const unresolved = Object.fromEntries(sig.unresolved.map((u) => [u.name, u]));
    expect(unresolved["Bash"].kind).toBe("builtin");
    expect(unresolved["plugin_unknownsrv"].kind).toBe("mcp_server");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scanWorkflow hooks, instructions, co-occurrence", () => {
  const invWithHook: ProjectInventory = {
    ...inventory,
    hooks: [{ type: "hook", name: "PreToolUse · Bash", event: "PreToolUse", matcher: "Bash", config: { hooks: [{ command: "guard.sh" }] }, source: "project" }],
  };

  it("flags hooks (low confidence) and instructions (presence), and pairs co-occurrence", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfscan3-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, [
      assistantToolUse("Skill", { skill: "qa" }),
      assistantToolUse("mcp__plugin_context7_context7__query-docs"),
      JSON.stringify({ type: "user", content: "PreToolUse:Bash [guard.sh] hook success: ok" }),
    ].join("\n") + "\n");

    const sig = scanWorkflow([file], { project: invWithHook });
    const byName = Object.fromEntries(sig.artifacts.map((a) => [a.name, a]));
    expect(byName["PreToolUse · Bash"].confidence).toBe("low");
    expect(byName["PreToolUse · Bash"].invocations).toBeGreaterThanOrEqual(1);
    expect(byName["CLAUDE.md"].type).toBe("instructions");
    expect(byName["CLAUDE.md"].invocations).toBe(1);
    const pair = sig.coOccurrence.find((c) => [c.a, c.b].includes("qa") && [c.a, c.b].includes("context7"));
    expect(pair?.sessions).toBe(1);
    // the session's shape is the set of artifacts it exercised
    const shape = sig.shapes.find((s) => s.artifacts.includes("qa") && s.artifacts.includes("context7"));
    expect(shape?.sessions).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("empty scan yields a valid zero signal with a note", () => {
    const sig = scanWorkflow([], { project: inventory });
    expect(sig.sessions.scanned).toBe(0);
    expect(sig.artifacts.every((a) => a.invocations === 0 || a.type === "instructions")).toBe(true);
    expect(sig.notes.some((n) => /no transcripts/i.test(n))).toBe(true);
  });

  it("skips malformed lines and records a note", () => {
    const dir = mkdtempSync(join(tmpdir(), "wfscan4-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, ["{ not json", assistantToolUse("Skill", { skill: "qa" })].join("\n") + "\n");
    const sig = scanWorkflow([file], { project: inventory });
    expect(sig.notes.some((n) => /unparseable/i.test(n))).toBe(true);
    expect(sig.artifacts.find((a) => a.name === "qa")!.invocations).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
