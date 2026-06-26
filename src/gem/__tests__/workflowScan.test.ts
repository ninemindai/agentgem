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

function assistantText(text: string) {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}
function userText(text: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, ...extra });
}

describe("scanWorkflow retainSequences / procedures / missionHint", () => {
  function write(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wfseq-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }
  const PROC = [
    assistantToolUse("Bash", { command: "git checkout -b feat" }),
    assistantToolUse("Edit", { file_path: "/repo/a.ts", new_string: "ghp_supersecretvalue000000" }),
    assistantToolUse("Bash", { command: "npx vitest run" }),
    assistantToolUse("Bash", { command: "git commit -m done" }),
  ];

  it("is off by default — no sequences/procedures", () => {
    const file = write([assistantToolUse("Bash", { command: "ls" })]);
    const sig = scanWorkflow([file], { project: inventory });
    expect(sig.sequences).toBeUndefined();
    expect(sig.procedures).toBeUndefined();
  });

  it("captures ordered scrubbed builtin steps, dropping content fields", () => {
    const file = write(PROC);
    const sig = scanWorkflow([file], { project: inventory }, { retainSequences: true });
    const steps = sig.sequences!.sessions[0].steps;
    expect(steps.map((s) => s.verb)).toEqual(["Bash:git checkout", "Edit", "Bash:npx vitest", "Bash:git commit"]);
    const edit = steps.find((s) => s.tool === "Edit")!;
    expect(edit.arg).toContain("/repo/a.ts");
    expect(JSON.stringify(steps)).not.toContain("ghp_supersecretvalue000000");
  });

  it("groups a recurring builtin-only procedure across sessions (resolves F1)", () => {
    const f1 = write(PROC);
    const f2 = write(PROC);
    const sig = scanWorkflow([f1, f2], { project: inventory }, { retainSequences: true });
    const top = sig.procedures![0];
    expect(top.sessions).toBe(2);
    expect(top.verbs).toContain("Bash:git commit");
  });

  it("extracts a mission hint, skipping the local-command-caveat wrapper", () => {
    const file = write([
      userText("<local-command-caveat>Caveat: generated by a local command</local-command-caveat>\n/ship"),
      userText("Add the skill distillation feature to the analyzer"),
      assistantToolUse("Bash", { command: "git commit -m feat" }),
      assistantText("Done — shipped the distillation feature."),
    ]);
    const sig = scanWorkflow([file], { project: inventory }, { retainSequences: true });
    const hint = sig.sequences!.sessions[0].missionHint!;
    expect(hint.task).toContain("Add the skill distillation feature");
    expect(hint.task).not.toContain("local-command-caveat");
    expect(hint.outcome).toContain("shipped the distillation feature");
  });
});

describe("scanWorkflow procedure spine excludes navigation noise", () => {
  function write(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wfnav-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }
  // cd / ls noise around a stable action spine; two identical sessions must group.
  const NOISY = [
    assistantToolUse("Bash", { command: "cd /Users/me/app" }),
    assistantToolUse("Bash", { command: "ls -la" }),
    assistantToolUse("Edit", { file_path: "/a.ts", new_string: "x" }),
    assistantToolUse("Bash", { command: "git add -A" }),
    assistantToolUse("Bash", { command: "npx vitest run" }),
    assistantToolUse("Bash", { command: "git commit -m done" }),
  ];

  it("groups two sessions by action spine, dropping Bash:cd/Bash:ls", () => {
    const sig = scanWorkflow([write(NOISY), write(NOISY)], { project: inventory }, { retainSequences: true });
    const top = sig.procedures![0];
    expect(top.sessions).toBe(2);
    expect(top.verbs).not.toContain("Bash:cd");
    expect(top.verbs).not.toContain("Bash:ls");
    expect(top.verbs).toContain("Bash:git commit");
    expect(top.verbs.length).toBeGreaterThanOrEqual(4);
  });
});

describe("scanWorkflow mines recurring SUB-patterns (n-grams) across differing sessions", () => {
  function write(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "wfgram-"));
    const file = join(dir, "s.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }
  const COMMON = [
    assistantToolUse("Edit", { file_path: "/a.ts" }),
    assistantToolUse("Bash", { command: "git add -A" }),
    assistantToolUse("Bash", { command: "npx vitest run" }),
    assistantToolUse("Bash", { command: "git commit -m x" }),
  ];
  // three sessions share the COMMON 4-gram but have different surrounding steps —
  // whole-session keys would never collide; n-gram mining must find the shared run.
  const A = [assistantToolUse("Write", { file_path: "/n.ts" }), ...COMMON];
  const B = [...COMMON, assistantToolUse("Bash", { command: "gh pr create" })];
  const C = [assistantToolUse("Bash", { command: "tsc -b" }), ...COMMON];

  it("surfaces the shared 4-gram with support 3", () => {
    const sig = scanWorkflow([write(A), write(B), write(C)], { project: inventory }, { retainSequences: true });
    const shared = sig.procedures!.find((p) => p.verbs.includes("Bash:git commit") && p.verbs.includes("Bash:npx vitest"));
    expect(shared).toBeDefined();
    expect(shared!.sessions).toBe(3);
    expect(shared!.verbs.length).toBeGreaterThanOrEqual(4);
  });
});
