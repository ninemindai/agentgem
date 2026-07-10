// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//
// The gate for the raw-rows change. `computeGlobalUsage` resolves at PARSE time; the indexed path
// stores raw tokens and resolves at QUERY time. matchSkill/matchMcpServer are lossy and
// order-dependent (`find`, first match wins), so equivalence is a property to PROVE over a corpus,
// not to assume from unit tests.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeGlobalUsage, getGlobalUsageIndexed, closeSharedIndex } from "@agentgem/capture";
import { allClaudeTranscripts } from "@agentgem/insight";
import { resolveDirs } from "@agentgem/model";

let home: string, claudeDir: string, prevHome: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "diff-"));
  prevHome = process.env.AGENTGEM_HOME;
  process.env.AGENTGEM_HOME = home;        // keep the index db inside the fixture
  claudeDir = join(home, ".claude");

  // A skill whose runtime token is namespaced (exercises matchSkill's `:`-suffix branch),
  // one addressed by its bare name, and one that is never installed (must stay unresolved).
  for (const n of ["brainstorming", "qa"]) {
    const d = join(claudeDir, "skills", n);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${n}\ndescription: d\n---\nbody`);
  }
  // An MCP server whose runtime token embeds its name (exercises matchMcpServer's substring branch).
  writeFileSync(join(claudeDir, ".mcp.json"), JSON.stringify({ mcpServers: { context7: { command: "x" } } }));
  // A hook, so hook rows participate too.
  writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/notify.sh" }] }] },
  }));

  const tu = (name: string, input?: unknown) =>
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
  const a = join(claudeDir, "projects", "encA"); mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "a.jsonl"), [
    JSON.stringify({ cwd: "/projA" }),
    tu("Skill", { skill: "superpowers:brainstorming" }),   // namespaced token
    tu("Skill", { skill: "brainstorming" }),               // bare token -> SAME artifact, same file
    tu("Skill", { skill: "never-installed" }),             // unresolved
    tu("mcp__plugin_context7_context7__query-docs", {}),   // substring token
    JSON.stringify({ type: "system", content: "Stop hook success: notify.sh" }),
  ].join("\n") + "\n");
  const b = join(claudeDir, "projects", "encB"); mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "b.jsonl"), [
    JSON.stringify({ cwd: "/projB" }),
    tu("Skill", { skill: "qa" }),
    tu("mcp__plugin_context7_context7__other", {}),
  ].join("\n") + "\n");
});

afterAll(async () => {
  await closeSharedIndex();
  if (prevHome === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const key = (a: { type: string; name: string }) => `${a.type} ${a.name}`;
const sorted = <T extends { type: string; name: string }>(xs: T[]) => [...xs].sort((x, y) => key(x).localeCompare(key(y)));

describe("differential: query-time resolution == parse-time resolution", () => {
  it("produces identical artifacts (type, name, invocations, sessionsUsedIn, lastUsedMs)", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    const want = computeGlobalUsage(dirs, paths).artifacts;
    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    expect(sorted(got)).toEqual(sorted(want));
    expect(want.length).toBeGreaterThan(0); // guard: an empty corpus would make this vacuous
  });

  // Two tokens ("superpowers:brainstorming", "brainstorming") resolve to ONE artifact in ONE file.
  // If sessionsUsedIn were a stored per-row count, this would report 2.
  it("counts one session when two raw tokens resolve to one artifact in one file", async () => {
    const dirs = resolveDirs(claudeDir);
    const got = (await getGlobalUsageIndexed(dirs, allClaudeTranscripts(dirs.claudeDir))).artifacts;
    const b = got.find((a) => a.name === "brainstorming")!;
    expect(b.invocations).toBe(2);
    expect(b.sessionsUsedIn).toBe(1);
  });

  it("omits an unresolved token from the result", async () => {
    const dirs = resolveDirs(claudeDir);
    const got = (await getGlobalUsageIndexed(dirs, allClaudeTranscripts(dirs.claudeDir))).artifacts;
    expect(got.find((a) => a.name === "never-installed")).toBeUndefined();
  });
});

describe("installing a skill reparses nothing", () => {
  it("resolves a previously-unresolved token without re-reading any file", async () => {
    const dirs = resolveDirs(claudeDir);
    const paths = allClaudeTranscripts(dirs.claudeDir);

    // Warm the index. "never-installed" is stored as a raw token, unresolved.
    await getGlobalUsageIndexed(dirs, paths);

    // Install the skill. No transcript changes: mtime and size are untouched.
    const d = join(claudeDir, "skills", "never-installed");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), "---\nname: never-installed\ndescription: d\n---\nbody");

    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    const n = got.find((a) => a.name === "never-installed");
    expect(n).toBeTruthy();          // it lights up...
    expect(n!.invocations).toBe(1);  // ...with its historical usage, from stored raw rows
  });
});

// Opt-in: runs the differential over the REAL ~/.claude/projects corpus. Skipped by default (no
// env var) so CI never depends on the local machine's transcript history. Run manually once
// before merge: AGENTGEM_DIFFERENTIAL_REAL=1 pnpm exec vitest run dist/gem/__tests__/usageDifferential.test.js
//
// lastUsedMs is EXCLUDED from this comparison (unlike the fixture differential above, which
// asserts full equality including lastUsedMs). computeGlobalUsage takes ~20s to scan a real
// multi-GB corpus, so the two paths run ~20s apart; if an agentgem session is live during that
// window, its own transcript file's mtime advances between the two reads. lastUsedMs is derived
// from that mtime (old path: safeMtime(path); new path: transcript_file.mtime_ms re-stat'd at
// sync time), so every artifact whose MAX(lastUsedMs) comes from the live file shifts by ~the
// scan duration between runs -- a live-corpus race, not a logic bug. type/name/invocations/
// sessionsUsedIn are unaffected and still compared exactly. Timestamp resolution itself is not
// left uncovered: the fixture differential's static files don't move, so it still asserts full
// lastUsedMs equality.
const strip = (a: { type: string; name: string; root: string | null; invocations: number; sessionsUsedIn: number }) => ({
  type: a.type,
  name: a.name,
  root: a.root,
  invocations: a.invocations,
  sessionsUsedIn: a.sessionsUsedIn,
});

describe.skipIf(!process.env.AGENTGEM_DIFFERENTIAL_REAL)("differential: real corpus (opt-in)", () => {
  it("produces identical artifacts over ~/.claude/projects (excluding lastUsedMs)", async () => {
    const dirs = resolveDirs(undefined);
    const paths = allClaudeTranscripts(dirs.claudeDir);
    const want = computeGlobalUsage(dirs, paths).artifacts;
    const got = (await getGlobalUsageIndexed(dirs, paths)).artifacts;
    expect(sorted(got).map(strip)).toEqual(sorted(want).map(strip));
    expect(want.length).toBeGreaterThan(0); // guard: an empty corpus would make this vacuous
  }, 120_000); // a real ~/.claude/projects corpus can run to thousands of transcripts
});
