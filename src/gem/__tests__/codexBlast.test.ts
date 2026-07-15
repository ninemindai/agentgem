// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/codexBlast.test.ts
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanCodexSessionBlast, resolveCodexSession } from "@agentgem/insight";

const CWD = "/Users/testuser/proj";
const rec = (o: object) => JSON.stringify(o);
const call = (name: string, args: object | string, id = "c1") =>
  rec({ type: "response_item", timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "function_call", name, call_id: id, arguments: typeof args === "string" ? args : JSON.stringify(args) } });
const output = (id: string, out: string) =>
  rec({ type: "response_item", timestamp: "2026-07-15T10:00:01.000Z", payload: { type: "function_call_output", call_id: id, output: out } });

describe("scanCodexSessionBlast", () => {
  it("classifies commands by semantics: read/search commands surface path targets, others stay exec", () => {
    const text = [
      rec({ type: "session_meta", payload: { id: "x1", cwd: CWD } }),
      call("exec_command", { cmd: `cat ${CWD}/src/index.ts` }, "c1"),
      call("exec_command", { cmd: `rg pattern ${CWD}/packages` }, "c2"),
      call("exec_command", { cmd: "git commit -m done" }, "c3"),
      call("shell", { command: ["cat", "/etc/hosts"] }, "c4"),
    ].join("\n");
    const rep = scanCodexSessionBlast(text, { cwd: CWD });
    expect(rep.events.map((e) => [e.action, e.target, e.zone ?? null])).toEqual([
      ["read", "src/index.ts", "project"],
      ["search", "packages", "project"],
      ["exec", "git commit", null],
      ["read", "/etc/hosts", "outside"],
    ]);
    expect(rep.meta.sessionId).toBe("x1");
    expect(rep.meta.project).toBe("~/proj");
  });

  it("maps apply_patch file headers to edit events and spawn_agent to agent", () => {
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: docs/b.md\n*** End Patch";
    const text = [
      rec({ type: "session_meta", payload: { id: "x2", cwd: CWD } }),
      call("apply_patch", { input: patch }, "c1"),
      call("spawn_agent", { agent_type: "worker", message: "long prompt dropped" }, "c2"),
    ].join("\n");
    const rep = scanCodexSessionBlast(text, { cwd: CWD });
    expect(rep.events.map((e) => [e.action, e.target])).toEqual([
      ["edit", "src/a.ts"],
      ["edit", "docs/b.md"],
      ["agent", "worker"],
    ]);
    expect(JSON.stringify(rep)).not.toContain("long prompt");
  });

  it("marks errors from a nonzero exit code in the paired output", () => {
    const text = [
      rec({ type: "session_meta", payload: { id: "x3", cwd: CWD } }),
      call("exec_command", { cmd: "npm test" }, "c1"),
      output("c1", "Chunk ID: 1\nProcess exited with code 1\nOutput:\nFAIL"),
      call("exec_command", { cmd: "npm run build" }, "c2"),
      output("c2", "Process exited with code 0\nOutput:\nok"),
    ].join("\n");
    const rep = scanCodexSessionBlast(text, { cwd: CWD });
    expect(rep.events[0].error).toBe(true);
    expect(rep.events[1].error).toBeUndefined();
    expect(JSON.stringify(rep)).not.toContain("FAIL");   // output content never kept
  });

  it("never mistakes glob/regex/redirection arguments for file targets", () => {
    const text = [
      rec({ type: "session_meta", payload: { id: "x4", cwd: CWD } }),
      call("exec_command", { cmd: `rg -g '!**/dist/**' -g '*.ts' "foo/bar(x)" ${CWD}/src 2>/dev/null` }, "c1"),
    ].join("\n");
    const rep = scanCodexSessionBlast(text, { cwd: CWD });
    expect(rep.events.map((e) => [e.action, e.target])).toEqual([["search", "src"]]);
  });

  it("is total: corrupt lines and empty input yield a valid report", () => {
    expect(scanCodexSessionBlast("").events).toEqual([]);
    expect(scanCodexSessionBlast("not json\n" + call("exec_command", { cmd: "ls" })).events).toHaveLength(1);
  });
});

describe("resolveCodexSession", () => {
  it("finds a rollout by session_meta id via a head read and returns its cwd", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexres-"));
    const dir = join(home, "sessions", "2026", "07", "15");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-a.jsonl"), rec({ type: "session_meta", payload: { id: "aaa", cwd: "/w/a" } }) + "\n");
    writeFileSync(join(dir, "rollout-b.jsonl"), rec({ type: "session_meta", payload: { id: "bbb", cwd: "/w/b" } }) + "\n");
    writeFileSync(join(dir, "not-a-rollout.jsonl"), rec({ type: "session_meta", payload: { id: "ccc" } }) + "\n");
    const found = await resolveCodexSession("bbb", { codexDir: home });
    expect(found?.path.endsWith("rollout-b.jsonl")).toBe(true);
    expect(found?.cwd).toBe("/w/b");
    expect(await resolveCodexSession("ccc", { codexDir: home })).toBeNull();   // non-rollout files skipped
    expect(await resolveCodexSession("zzz", { codexDir: home })).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});
