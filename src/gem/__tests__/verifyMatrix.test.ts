// src/gem/__tests__/verifyMatrix.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyGemAcrossAgents, deriveMatrixBaseDir, ledgerPath } from "@agentgem/run";
import type { RunConnectFn, ToolInvocation } from "@agentgem/run";
import type { Gem } from "@agentgem/model";

const gem: Gem = {
  name: "mx-gem",
  createdFrom: "test",
  artifacts: [{ type: "skill", name: "qa", source: "standalone", content: "# QA" }],
  checks: [],
  requiredSecrets: [],
  contract: { task: "exercise qa", expect: { tools: ["qa"] } },
};

// One fake serving both agents: the run dir ends with the agent id, so the fake
// invokes the contract-matching tool only in the claude dir — claude passes,
// codex fails verification.
const splitAgent: RunConnectFn = async () => ({
  ctx: {
    async open(cwd: string) {
      const title = cwd.endsWith("claude") ? "Skill(qa)" : "Bash(ls)";
      return {
        async setMode() {},
        async prompt(_t: string, _d?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
          const tool = { toolCallId: "t1", title, status: "completed" };
          onToolCall?.(tool);
          return { text: "done", toolCalls: [tool] };
        },
        dispose() {},
      };
    },
  },
  close() {},
});

describe("verifyGemAcrossAgents", () => {
  it("returns one verdict per roster agent in order, isolates dirs, ledgers each run", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    const baseDir = join(home, "matrix");
    try {
      const seen: string[] = [];
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir, home,
        roster: ["claude", "codex"],
        connectFn: splitAgent,
        onVerdict: (v) => seen.push(`${v.agent}:${v.status}`),
      });
      expect(verdicts.map((v) => `${v.agent}:${v.status}`)).toEqual(["claude:passed", "codex:failed"]);
      expect(seen).toEqual(["claude:passed", "codex:failed"]);
      expect(verdicts[0].verification?.passed).toBe(true);
      expect(verdicts[1].verification?.passed).toBe(false);
      // per-agent isolation: both dirs materialized, distinct
      expect(existsSync(join(baseDir, "claude", ".claude", "skills", "qa", "SKILL.md"))).toBe(true);
      expect(existsSync(join(baseDir, "codex"))).toBe(true);
      // ledger: exactly two records, contractApplied, digest present
      const lines = readFileSync(ledgerPath(home), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const recs = lines.map((l) => JSON.parse(l));
      expect(recs.map((r) => r.agent)).toEqual(["claude", "codex"]);
      expect(recs.every((r) => r.contractApplied === true)).toBe(true);
      expect(recs.every((r) => typeof r.gemDigest === "string" && r.gemDigest.length > 0)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports unavailable (no dir, no ledger row) when the adapter can't resolve and fetch is off", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    const baseDir = join(home, "matrix");
    try {
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir, home,
        roster: ["codex"],
        resolveAdapter: async (a, o) => {
          if (o?.allowFetch === false) throw new Error(`${a.name} adapter (${a.pkg}) is not installed and on-demand fetch is disabled`);
          return [a.bin];
        },
      });
      expect(verdicts).toEqual([
        { agent: "codex", status: "unavailable", detail: expect.stringContaining("not installed") },
      ]);
      expect(existsSync(join(baseDir, "codex"))).toBe(false);
      expect(existsSync(ledgerPath(home))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("throws InvalidInputError before any run when no contract exists anywhere", async () => {
    const bare: Gem = { ...gem, contract: undefined };
    await expect(verifyGemAcrossAgents({ gem: bare, baseDir: "/tmp/never", connectFn: splitAgent }))
      .rejects.toThrow(/contract/i);
  });

  it("an explicit contract argument overrides the gem's own", async () => {
    const home = mkdtempSync(join(tmpdir(), "agem-mx-"));
    try {
      const verdicts = await verifyGemAcrossAgents({
        gem, baseDir: join(home, "m"), home,
        roster: ["claude"],
        connectFn: splitAgent,
        contract: { task: "t", expect: { tools: ["never-invoked"] } },
      });
      expect(verdicts[0].status).toBe("failed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("deriveMatrixBaseDir", () => {
  it("sanitizes the name and stays inside the runs root", () => {
    const home = "/tmp/agem-home";
    expect(deriveMatrixBaseDir("my gem!", home)).toBe(join(home, ".agentgem", "runs", "my-gem--matrix"));
    expect(deriveMatrixBaseDir("..", home)).toBe(join(home, ".agentgem", "runs", "gem-matrix"));
  });
});
