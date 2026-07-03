import { describe, it, expect, vi, beforeEach } from "vitest";

const install = vi.hoisted(() => vi.fn(async (_s: string, _p: string, opts: { dryRun?: boolean } = {}) =>
  ({ ok: !opts.dryRun, skill: "ai-engineer", dir: "/home/u/.agents/skills/ai-engineer", content: "BODY" })));
vi.mock("../sourcesCore.js", () => ({ installAgencySkill: install }));

import { runSourcesCommand } from "../sourcesCli.js";

beforeEach(() => install.mockClear());

describe("runSourcesCommand", () => {
  it("install calls the core with sourceId + path and returns 0", async () => {
    const code = await runSourcesCommand(["install", "agency-agents", "engineering/ai-engineer.md"]);
    expect(code).toBe(0);
    expect(install).toHaveBeenCalledWith("agency-agents", "engineering/ai-engineer.md", { dryRun: false });
  });
  it("passes dryRun through", async () => {
    await runSourcesCommand(["install", "agency-agents", "engineering/ai-engineer.md", "--dry-run"]);
    expect(install).toHaveBeenCalledWith("agency-agents", "engineering/ai-engineer.md", { dryRun: true });
  });
  it("missing args returns 1 and does not call the core", async () => {
    const code = await runSourcesCommand(["install"]);
    expect(code).toBe(1);
    expect(install).not.toHaveBeenCalled();
  });
});
