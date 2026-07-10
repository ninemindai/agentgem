// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFileUsage, matchSkill, matchMcpServer, mcpServerToken } from "@agentgem/insight";
import type { HookArtifact } from "@agentgem/model";

let dir: string;
const line = (o: unknown) => JSON.stringify(o);
const toolUse = (name: string, input?: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "raw-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, lines: string[]) => {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
};

describe("scanFileUsage", () => {
  it("extracts raw skill tokens verbatim, counting invocations", () => {
    const p = write("a.jsonl", [
      toolUse("Skill", { skill: "superpowers:brainstorming" }),
      toolUse("Skill", { skill: "superpowers:brainstorming" }),
      toolUse("Skill", { skill: "qa" }),
    ]);
    const u = scanFileUsage(p, []);
    expect(u.raw.filter((r) => r.kind === "skill").sort((a, b) => a.token.localeCompare(b.token))).toEqual([
      { kind: "skill", token: "qa", invocations: 1 },
      { kind: "skill", token: "superpowers:brainstorming", invocations: 2 },
    ]);
  });

  it("reduces an mcp tool name to its server token", () => {
    const p = write("b.jsonl", [toolUse("mcp__plugin_context7_context7__query-docs", {})]);
    expect(scanFileUsage(p, []).raw).toEqual([
      { kind: "mcp_server", token: "plugin_context7_context7", invocations: 1 },
    ]);
  });

  // The system-prompt tool catalog also lists mcp__ names but is NOT an assistant
  // message. That is the availability-vs-usage guard; it must survive here.
  it("ignores tool_use blocks that are not on an assistant message", () => {
    const p = write("c.jsonl", [
      line({ type: "user", message: { role: "user", content: [{ type: "tool_use", name: "Skill", input: { skill: "qa" } }] } }),
    ]);
    expect(scanFileUsage(p, []).raw).toEqual([]);
  });

  it("ignores a Skill call with no input.skill, and unknown builtins", () => {
    const p = write("d.jsonl", [toolUse("Skill", {}), toolUse("Bash", { command: "ls" })]);
    expect(scanFileUsage(p, []).raw).toEqual([]);
  });

  it("skips malformed lines and blank lines without throwing", () => {
    const p = write("e.jsonl", ["", "{not json", toolUse("Skill", { skill: "qa" }), ""]);
    expect(scanFileUsage(p, []).raw).toEqual([{ kind: "skill", token: "qa", invocations: 1 }]);
  });

  it("returns a failed result for a missing file, not silently empty", () => {
    expect(scanFileUsage(join(dir, "nope.jsonl"), [])).toEqual({ raw: [], hooks: [], failed: true });
  });

  // Hooks have no token: a hook fired iff a hook-signal record contains that hook's
  // own event name or its command basename, both taken from the inventory.
  it("resolves hook hits against the hook inventory, by event or command basename", () => {
    const hooks: HookArtifact[] = [
      { type: "hook", name: "stopper", event: "Stop", config: { hooks: [{ command: "/usr/local/bin/notify.sh" }] } },
      { type: "hook", name: "pre", event: "PreToolUse", config: { hooks: [{ command: "/x/guard.sh" }] } },
      { type: "hook", name: "never", event: "Nope", config: { hooks: [{ command: "/x/absent.sh" }] } },
    ];
    const p = write("f.jsonl", [
      line({ type: "system", content: "PreToolUse hook success" }),
      line({ type: "system", content: "Hook fired: notify.sh done" }),
    ]);
    const u = scanFileUsage(p, hooks);
    expect(u.hooks.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "pre", invocations: 1 },
      { name: "stopper", invocations: 1 },
    ]);
  });

  // T-H: two hooks matching one record both count; a record matching the hook-signal
  // heuristic but firing no configured hook contributes zero hooks.
  it("counts every hook that matches a single record, and zero when none match", () => {
    const hooks: HookArtifact[] = [
      { type: "hook", name: "a", event: "PreToolUse", config: { hooks: [{ command: "/x/a.sh" }] } },
      { type: "hook", name: "b", event: "PreToolUse", config: { hooks: [{ command: "/x/b.sh" }] } },
      { type: "hook", name: "c", event: "PostToolUse", config: { hooks: [{ command: "/x/c.sh" }] } },
    ];
    const p = write("h.jsonl", [
      line({ type: "system", content: "PreToolUse hook success" }),
      line({ type: "system", content: "Hook nothing configured here" }),
    ]);
    const u = scanFileUsage(p, hooks);
    expect(u.hooks.sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a", invocations: 1 },
      { name: "b", invocations: 1 },
    ]);
  });

  it("does not report lastUsedMs (that is derived from transcript_file at query time)", () => {
    const p = write("g.jsonl", [toolUse("Skill", { skill: "qa" })]);
    const u = scanFileUsage(p, []);
    expect(u).not.toHaveProperty("lastUsedMs");
  });
});

describe("exported matchers (must be shared by mint and query, never re-implemented)", () => {
  it("matchSkill accepts an exact name or a namespaced suffix", () => {
    const list = [{ name: "brainstorming" }];
    expect(matchSkill(list, "brainstorming")).toBe("brainstorming");
    expect(matchSkill(list, "superpowers:brainstorming")).toBe("brainstorming");
    expect(matchSkill(list, "brainstorm")).toBeNull();
  });

  // A4: exact match outranks a `:`-suffix match, across the WHOLE inventory, regardless
  // of array order — resolution is a pure function of (token, inventory SET).
  it("matchSkill resolves an exact name over a suffix match, order-independent", () => {
    const forward = [{ name: "x:brainstorming" }, { name: "brainstorming" }];
    const reversed = [{ name: "brainstorming" }, { name: "x:brainstorming" }];
    expect(matchSkill(forward, "brainstorming")).toBe("brainstorming");
    expect(matchSkill(reversed, "brainstorming")).toBe("brainstorming");
  });

  // T-E: both matchers return null (not undefined) on no match.
  it("matchSkill and matchMcpServer both return null on no match", () => {
    expect(matchSkill([{ name: "a" }], "z")).toBeNull();
    expect(matchMcpServer("z", [{ name: "a" }])).toBeNull();
  });

  it("matchMcpServer matches equal or substring, case-insensitively", () => {
    const servers = [{ name: "context7" }];
    expect(matchMcpServer("context7", servers)).toBe("context7");
    expect(matchMcpServer("plugin_context7_context7", servers)).toBe("context7");
    expect(matchMcpServer("other", servers)).toBeNull();
  });

  it("mcpServerToken strips the mcp__ prefix and the trailing __tool", () => {
    expect(mcpServerToken("mcp__plugin_context7_context7__query-docs")).toBe("plugin_context7_context7");
    expect(mcpServerToken("mcp__bare")).toBe("bare");
  });
});
