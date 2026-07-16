// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeTranscript, parseCodexTranscript } from "../observeScan.js";
import { parseAtifMeta } from "../atif/atifImport.js";

// A session whose cwd is a linked git worktree (or a subdirectory of a checkout)
// belongs to the MAIN checkout's project, so worktree-per-task workflows don't
// fragment one repo's sessions across ephemeral paths.
let base: string;
let main: string;
let worktree: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "agentgem-observe-root-"));
  main = join(base, "shiny-repo");
  mkdirSync(join(main, ".git"), { recursive: true });
  mkdirSync(join(main, "packages", "web"), { recursive: true });
  worktree = join(base, "shiny-repo-worktrees", "task");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "task")}\n`);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function claudeText(cwd: string): string {
  return [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00Z", cwd, message: { content: "hi" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:01:00Z", message: { model: "claude-opus-4-8", content: [] } }),
  ].join("\n");
}

function codexText(cwd: string): string {
  return [
    JSON.stringify({ type: "session_meta", timestamp: "2026-07-01T00:00:00Z", payload: { id: "sess-1", cwd } }),
    JSON.stringify({ type: "response_item", timestamp: "2026-07-01T00:01:00Z", payload: { type: "message" } }),
  ].join("\n");
}

describe("scan normalizes project to the git checkout", () => {
  it("claude: a worktree cwd reports the main checkout's name, raw cwd preserved", () => {
    const stat = parseClaudeTranscript(claudeText(worktree), "/sessions/abc.jsonl");
    expect(stat?.project).toBe("shiny-repo");
    expect(stat?.cwd).toBe(worktree);
  });

  it("claude: a subdirectory cwd reports the checkout's name", () => {
    const stat = parseClaudeTranscript(claudeText(join(main, "packages", "web")), "/sessions/def.jsonl");
    expect(stat?.project).toBe("shiny-repo");
  });

  it("claude: a non-git cwd keeps its own basename", () => {
    const stat = parseClaudeTranscript(claudeText("/home/u/proj"), "/sessions/ghi.jsonl");
    expect(stat?.project).toBe("proj");
  });

  it("codex: a worktree cwd reports the main checkout's name", () => {
    const stat = parseCodexTranscript(codexText(worktree), "/sessions/rollout-1.jsonl");
    expect(stat?.project).toBe("shiny-repo");
    expect(stat?.cwd).toBe(worktree);
  });

  it("atif: a worktree cwd reports the main checkout's name", () => {
    const doc = JSON.stringify({
      schema_version: "ATIF-v1", trajectory_id: "t1", agent: { name: "a", model_name: "m" },
      steps: [{ source: "user", timestamp: "2026-07-01T00:00:00Z", message: "hi" }],
      extra: { cwd: worktree },
    });
    const stat = parseAtifMeta(doc, "/sessions/t1.json");
    expect(stat?.project).toBe("shiny-repo");
    expect(stat?.cwd).toBe(worktree);
  });
});
