// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentTasksController } from "@agentgem/app/agentTasks.controller";

const orig = process.env.AGENTGEM_HOME;
beforeEach(() => { process.env.AGENTGEM_HOME = mkdtempSync(join(tmpdir(), "agentgem-tasks-ctrl-")); });
afterEach(() => { if (orig === undefined) delete process.env.AGENTGEM_HOME; else process.env.AGENTGEM_HOME = orig; });

describe("AgentTasksController", () => {
  it("returns effective defaults when nothing is persisted", async () => {
    const r = await new AgentTasksController().getSettings();
    expect(r.families.report).toEqual({ agent: "claude-code", model: "claude-haiku-4-5" });
    expect(Object.keys(r.families).sort()).toEqual(["distill", "judge", "recommend", "report"]);
  });

  it("persists a per-family update and returns the merged map", async () => {
    const c = new AgentTasksController();
    const r = await c.setSetting({ body: { family: "report", agent: "claude-code", model: "default" } });
    expect(r.families.report).toEqual({ agent: "claude-code", model: "default" });
    expect(r.families.judge).toEqual({ agent: "claude-code", model: "claude-haiku-4-5" });
    // survives a fresh read
    expect((await c.getSettings()).families.report.model).toBe("default");
  });
});
