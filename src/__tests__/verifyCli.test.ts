// src/__tests__/verifyCli.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeGemArchive, writeArchiveDir } from "@agentgem/archive";
import { runVerifyCommand } from "../verifyCli.js";
import type { Gem } from "@agentgem/model";
import type { AgentVerdict } from "@agentgem/run";

function archiveWith(contract: boolean): string {
  const gem: Gem = {
    name: "cli-gem", createdFrom: "test",
    artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
    checks: [], requiredSecrets: [],
    ...(contract ? { contract: { task: "t", expect: { tools: ["qa"] } } } : {}),
  };
  const dir = mkdtempSync(join(tmpdir(), "gem-cli-"));
  writeArchiveDir(dir, writeGemArchive(gem).files);
  return dir;
}

const verdictsOf = (...vs: AgentVerdict[]) => async () => vs;

describe("agentgem verify", () => {
  it("prints one line per verdict and exits 0 when all available agents pass", async () => {
    const dir = archiveWith(true);
    const lines: string[] = [];
    try {
      const code = await runVerifyCommand([dir], {
        verify: verdictsOf(
          { agent: "claude", status: "passed", verification: { passed: true, checks: [] } },
          { agent: "codex", status: "unavailable", detail: "not installed" },
        ),
        out: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      expect(lines.some((l) => l.includes("claude") && l.includes("passed"))).toBe(true);
      expect(lines.some((l) => l.includes("codex") && l.includes("unavailable"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exits 1 when any agent fails, and when no agent is available", async () => {
    const dir = archiveWith(true);
    try {
      expect(await runVerifyCommand([dir], {
        verify: verdictsOf({ agent: "claude", status: "failed", verification: { passed: false, checks: [{ name: "x", passed: false, detail: "d" }] } }),
        out: () => {},
      })).toBe(1);
      expect(await runVerifyCommand([dir], {
        verify: verdictsOf({ agent: "claude", status: "unavailable", detail: "not installed" }),
        out: () => {},
      })).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("exits 2 on usage errors: no archive arg, unknown --agents id, contract-less gem", async () => {
    const errs: string[] = [];
    expect(await runVerifyCommand([], { err: (l) => errs.push(l) })).toBe(2);
    const noContract = archiveWith(false);
    const withContract = archiveWith(true);
    try {
      // No injected verify here: the REAL core throws InvalidInputError for a
      // contract-less gem before touching any adapter, so this stays hermetic.
      expect(await runVerifyCommand([noContract], { err: (l) => errs.push(l) })).toBe(2);
      expect(await runVerifyCommand([withContract, "--agents", "gemini"], { verify: verdictsOf(), err: (l) => errs.push(l) })).toBe(2);
      expect(errs.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(noContract, { recursive: true, force: true });
      rmSync(withContract, { recursive: true, force: true });
    }
  });

  it("passes --fetch and --agents through to the core", async () => {
    const dir = archiveWith(true);
    let got: { roster?: string[]; fetch?: boolean } = {};
    try {
      await runVerifyCommand([dir, "--agents", "claude", "--fetch"], {
        verify: async (o) => { got = { roster: o.roster, fetch: o.fetch }; return []; },
        out: () => {},
      });
      expect(got).toEqual({ roster: ["claude"], fetch: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps a positional that duplicates the --agents value (old indexOf filter dropped it)", async () => {
    // The dir is literally named "claude" — same string as the --agents value —
    // which the old first-occurrence (indexOf) filter dropped from positionals.
    const src = archiveWith(true);
    const parent = mkdtempSync(join(tmpdir(), "gem-cli-collide-"));
    renameSync(src, join(parent, "claude"));
    const prevCwd = process.cwd();
    process.chdir(parent);
    let roster: string[] | undefined;
    try {
      const code = await runVerifyCommand(["--agents", "claude", "claude"], {
        verify: async (o) => { roster = o.roster; return [{ agent: "claude", status: "passed", verification: { passed: true, checks: [] } }]; },
        out: () => {},
      });
      expect(code).toBe(0);
      expect(roster).toEqual(["claude"]);
    } finally {
      process.chdir(prevCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("exits 2 when --agents has no value", async () => {
    const dir = archiveWith(true);
    const errs: string[] = [];
    try {
      expect(await runVerifyCommand([dir, "--agents"], { err: (l) => errs.push(l) })).toBe(2);
      expect(errs.some((l) => l.includes("--agents requires"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
