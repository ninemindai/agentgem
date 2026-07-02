// src/gem/__tests__/sources.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_SOURCES } from "@agentgem/insight";

const claudeSpec = () => BUILTIN_SOURCES.find((s) => s.id === "claude")!;

describe("SourceSpec built-ins", () => {
  it("registers claude, cline, codex, continue, and gemini", () => {
    expect(BUILTIN_SOURCES.map((s) => s.id).sort()).toEqual(["claude", "cline", "codex", "continue", "gemini"]);
  });
  it("claude spec scans a fixture transcript into a SessionStat", async () => {
    const base = mkdtempSync(join(tmpdir(), "src-"));
    const proj = join(base, ".claude", "projects", "p"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "11111111-1111-1111-1111-111111111111.jsonl"),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", cwd: "/x/demo", message: { model: "claude-sonnet-5", usage: { input_tokens: 10, output_tokens: 5 } } }) + "\n");
    const spec = claudeSpec();
    const stats = await spec.scanSessions!(spec.roots({ baseDir: join(base, ".claude") }));
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ agent: "claude", project: "demo", model: "claude-sonnet-5", tokensIn: 10, tokensOut: 5 });
  });
  it("returns [] roots and never throws when the agent dir is absent", async () => {
    const spec = claudeSpec();
    const roots = spec.roots({ baseDir: "/no/such/dir/.claude" });
    await expect(spec.scanSessions!(roots)).resolves.toEqual([]);
  });
});
