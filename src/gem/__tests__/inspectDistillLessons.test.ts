// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/gem/__tests__/inspectDistillLessons.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConnectFnForTests, type AcpConnectFn } from "@agentgem/insight";
import { GemController } from "../../gem.controller.js";

let home: string, prevHome: string | undefined, prevAg: string | undefined;
const fakeConnect = (canned: string): AcpConnectFn => async () => ({
  ctx: { async open(_c: string) { let m = "default";
    return { async setMode(x: string) { m = x; }, async promptText(_t: string) { if (m !== "plan") throw new Error("mode"); return canned; }, dispose() {} }; } }, close() {} });

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "idl-"));
  prevHome = process.env.HOME; prevAg = process.env.AGENTGEM_HOME;
  process.env.HOME = home; process.env.AGENTGEM_HOME = home;
  const proj = join(home, ".claude", "projects", "p"); mkdirSync(proj, { recursive: true });
  // A missioned Claude session: a user task + an assistant edit + a git commit (so the scan yields a mission hint + steps).
  writeFileSync(join(proj, "sess1.jsonl"), [
    JSON.stringify({ type: "user", uuid: "u1", cwd: home + "/work", timestamp: "2026-06-29T10:00:00.000Z", message: { role: "user", content: "fix the flaky CI test" } }),
    JSON.stringify({ type: "assistant", uuid: "a1", cwd: home + "/work", timestamp: "2026-06-29T10:00:05.000Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "x.ts" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "git commit -m fix" } } ] } }),
    JSON.stringify({ type: "assistant", uuid: "a2", cwd: home + "/work", timestamp: "2026-06-29T10:01:00.000Z", message: { role: "assistant", content: "Fixed — pinned the seed." } }),
  ].join("\n") + "\n");
  mkdirSync(join(home, "work"), { recursive: true });
});
afterAll(() => { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  if (prevAg === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = prevAg;
  rmSync(home, { recursive: true, force: true }); });
beforeEach(() => setConnectFnForTests(fakeConnect(JSON.stringify({ lessons: [{ body: "Pin the flaky test seed first.", importance: "high" }] }))));
afterEach(() => setConnectFnForTests(null));

describe("POST /api/inspect/distill — lessons", () => {
  it("returns lessons alongside skills for a Claude session", async () => {
    const res = await new GemController().inspectDistill({ body: { id: "sess1", agent: "claude" } });
    expect(Array.isArray(res.distilled)).toBe(true);          // skills field intact
    expect(Array.isArray(res.lessons)).toBe(true);            // new lessons field
    expect(res.lessons.some((l) => l.name === "pin-the-flaky-test-seed-first")).toBe(true);
  });
});
