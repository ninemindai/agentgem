import { describe, it, expect, vi } from "vitest";
import { installSkill } from "@agentgem/insight";

describe("installSkill", () => {
  type Run = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

  it("runs `skills add <source>@<id> --global --yes` and reports success", async () => {
    const run = vi.fn<Run>(async () => ({ stdout: "Installed 1 skill\n  ✓ ~/.agents/skills/playwright", stderr: "" }));
    const out = await installSkill("openai/skills", "playwright", { run });
    expect(out.ok).toBe(true);
    expect(out.skill).toBe("openai/skills@playwright");
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual(["-y", "skills", "add", "openai/skills@playwright", "--global", "--yes"]);
  });

  it("rejects a malformed source WITHOUT executing", async () => {
    const run = vi.fn<Run>(async () => ({ stdout: "", stderr: "" }));
    for (const bad of ["openai/skills; rm -rf ~", "openai skills", "../etc", "openai/sk ills", "openai/"]) {
      const out = await installSkill(bad, "playwright", { run });
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/invalid/i);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a malformed skillId WITHOUT executing", async () => {
    const run = vi.fn<Run>(async () => ({ stdout: "", stderr: "" }));
    for (const bad of ["play wright", "play;wright", "a/b", ""]) {
      const out = await installSkill("openai/skills", bad, { run });
      expect(out.ok).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("degrades to ok:false on a non-zero exit (never throws)", async () => {
    const run = vi.fn<Run>(async () => { const e: any = new Error("Command failed"); e.stderr = "Repository not found"; e.code = 1; throw e; });
    const out = await installSkill("nope/nope", "ghost", { run });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Repository not found/);
  });

  it("strips ANSI/spinner noise from the returned message", async () => {
    const noisy = "[2K[36m◒  Cloning repository[0m\rInstalled 1 skill";
    const run = vi.fn<Run>(async () => ({ stdout: noisy, stderr: "" }));
    const out = await installSkill("openai/skills", "playwright", { run });
    expect(out.ok).toBe(true);
    expect(out.message).not.toMatch(/\[/);
    expect(out.message).toContain("Installed 1 skill");
  });
});
