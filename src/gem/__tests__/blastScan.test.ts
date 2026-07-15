// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/blastScan.test.ts
import { describe, it, expect } from "vitest";
import { scanSessionBlast } from "@agentgem/insight";

const CWD = "/Users/testuser/proj";

const rec = (o: object) => JSON.stringify(o);
const use = (name: string, input: object, extra: object = {}, id?: string) =>
  rec({ timestamp: "2026-07-15T10:00:00.000Z", message: { role: "assistant", content: [{ type: "tool_use", name, input, ...(id ? { id } : {}) }] }, ...extra });

describe("scanSessionBlast", () => {
  it("classifies path targets into project/home/tmp/outside zones with relative project targets", () => {
    const text = [
      rec({ sessionId: "s1", cwd: CWD, type: "user", message: { role: "user", content: "go" } }),
      use("Read", { file_path: `${CWD}/src/index.ts` }),
      use("Edit", { file_path: "/Users/testuser/.zshrc", old_string: "SECRET CONTENT", new_string: "x" }),
      use("Write", { file_path: "/private/tmp/scratch/out.txt", content: "dump" }),
      use("Read", { file_path: "/etc/hosts" }),
      use("Grep", { pattern: "*.ts" }),
    ].join("\n");
    const rep = scanSessionBlast(text, { cwd: CWD });
    expect(rep.events.map((e) => [e.action, e.target, e.zone])).toEqual([
      ["read", "src/index.ts", "project"],
      ["edit", "~/.zshrc", "home"],
      ["edit", "/private/tmp/scratch/out.txt", "tmp"],
      ["read", "/etc/hosts", "outside"],
      ["search", "*.ts", "project"],
    ]);
    // file contents / edit bodies never survive
    expect(JSON.stringify(rep)).not.toContain("SECRET CONTENT");
    expect(rep.meta.sessionId).toBe("s1");
    expect(rep.meta.project).toBe("~/proj");
  });

  it("maps Bash to a coarse verb, Skill/Task/mcp__ to their names, unknown tools to other", () => {
    const text = [
      use("Bash", { command: `git commit -m "leak ghp_abcdefghijklmnop123456"` }),
      use("Skill", { skill: "superpowers:brainstorming" }),
      use("Task", { subagent_type: "Explore", prompt: "long prompt that must be dropped" }),
      use("mcp__plugin_github_github__get_me", {}),
      use("SomeNewTool", { anything: "dropped" }),
    ].join("\n");
    const rep = scanSessionBlast(text, { cwd: CWD });
    expect(rep.events.map((e) => [e.tool, e.action, e.target])).toEqual([
      ["Bash", "exec", "git commit"],
      ["Skill", "skill", "superpowers:brainstorming"],
      ["Task", "agent", "Explore"],
      ["mcp", "mcp", "plugin_github_github"],
      ["SomeNewTool", "other", null],
    ]);
    const flat = JSON.stringify(rep);
    expect(flat).not.toContain("ghp_abcdefghijklmnop123456");
    expect(flat).not.toContain("long prompt");
  });

  it("pairs tool_result errors back by tool_use_id and flags sidechain events", () => {
    const text = [
      use("Read", { file_path: `${CWD}/a.ts` }, {}, "tu_1"),
      rec({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: "boom" }] } }),
      use("Edit", { file_path: `${CWD}/b.ts` }, { isSidechain: true }, "tu_2"),
      rec({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: false }] } }),
    ].join("\n");
    const rep = scanSessionBlast(text, { cwd: CWD });
    expect(rep.events[0].error).toBe(true);
    expect(rep.events[1].sidechain).toBe(true);
    expect(rep.events[1].error).toBeUndefined();
    expect(JSON.stringify(rep)).not.toContain("boom"); // result content never kept
  });

  it("is uncapped (unlike scanWorkflow steps) and totals timestamps into meta", () => {
    const lines = [rec({ sessionId: "s2", cwd: CWD, type: "user", message: { role: "user", content: "go" } })];
    for (let i = 0; i < 60; i++) {
      lines.push(rec({
        timestamp: `2026-07-15T10:${String(i).padStart(2, "0")}:00.000Z`,
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { file_path: `${CWD}/f${i}.ts` } }] },
      }));
    }
    const rep = scanSessionBlast(lines.join("\n"), { cwd: CWD });
    expect(rep.events).toHaveLength(60);
    expect(rep.events.every((e, i) => e.seq === i)).toBe(true);
    expect(rep.meta.startMs).toBe(Date.parse("2026-07-15T10:00:00.000Z"));
    expect(rep.meta.endMs).toBe(Date.parse("2026-07-15T10:59:00.000Z"));
  });

  it("is total: corrupt lines and empty input yield a valid report", () => {
    expect(scanSessionBlast("").events).toEqual([]);
    const rep = scanSessionBlast("not json\n" + use("Read", { file_path: `${CWD}/ok.ts` }), { cwd: CWD });
    expect(rep.events).toHaveLength(1);
  });
});
