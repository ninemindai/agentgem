// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Settings surface for background agent tasks (report render, distill, recommender,
// judge): which local agent runs each family and which model it requests. Backed by
// ~/.agentgem/agent-tasks.json via @agentgem/base agentTasks. Mirrors
// BenchmarkProxyController's contribute-setting shape.
import { z } from "zod";
import { api, get, post } from "@agentback/openapi";
import { AGENT_TASK_FAMILIES, effectiveAgentTaskPrefs, saveAgentTaskPref } from "@agentgem/base";

const Family = z.enum(AGENT_TASK_FAMILIES);
const TaskPref = z.object({ agent: z.string(), model: z.string() });
const Settings = z.object({
  families: z.object({ report: TaskPref, distill: TaskPref, recommend: TaskPref, judge: TaskPref }),
});
const UpdateBody = z.object({ family: Family, agent: z.string().min(1), model: z.string().min(1) });

@api({ basePath: "/api/agent-tasks" })
export class AgentTasksController {
  @get("/settings", { response: Settings })
  async getSettings(): Promise<z.infer<typeof Settings>> {
    return { families: effectiveAgentTaskPrefs() };
  }

  @post("/settings", { body: UpdateBody, response: Settings })
  async setSetting(input: { body: z.infer<typeof UpdateBody> }): Promise<z.infer<typeof Settings>> {
    const { family, agent, model } = input.body;
    saveAgentTaskPref(family, { agent, model });
    return { families: effectiveAgentTaskPrefs() };
  }
}
