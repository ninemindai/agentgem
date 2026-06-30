import { describe, it, expect } from "vitest";
import { InstallSkillResultSchema } from "../../gem.controller.js";
import { installSkill } from "@agentgem/insight";

describe("InstallSkillResult contract", () => {
  it("accepts a real installSkill result (rejected ref — no exec)", async () => {
    const result = await installSkill("../bad", "ghost");
    expect(result.ok).toBe(false);
    expect(() => InstallSkillResultSchema.parse(result)).not.toThrow();
  });

  it("accepts a success-shaped result", () => {
    expect(() => InstallSkillResultSchema.parse({ ok: true, skill: "a/b@c", message: "installed" })).not.toThrow();
  });
});
