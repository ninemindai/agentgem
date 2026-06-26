// src/gem/__tests__/runGem.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeGemToTestbed, materializeAndRunGem, AGENT_ADAPTERS, registerRun, resolveRun, resolveAdapterCommand, resolveOrFetchAdapter, adapterCacheDir, type AgentAdapter, type AdapterInstaller } from "../runGem.js";
import type { RunConnectFn, RunResult } from "../acpRun.js";
import type { Gem } from "../types.js";

// A fake adapter whose package is neither on PATH nor a real dep, so resolution
// always reaches the fetch tier (driven by an injected installer — never network).
const FAKE_ADAPTER: AgentAdapter = { id: "codex", name: "Fake", pkg: "fake-acp-pkg", bin: "fake-acp-bin", version: "9.9.9", flavor: "codex", validated: true };
function installFakeInto(prefixDir: string): void {
  const dir = join(prefixDir, "node_modules", "fake-acp-pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fake-acp-pkg", version: "9.9.9", bin: { "fake-acp-bin": "index.js" } }));
  writeFileSync(join(dir, "index.js"), "");
}

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "rungem-")); tmps.push(d); return d; };
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

const gem: Gem = {
  name: "qa-gem",
  createdFrom: "test",
  artifacts: [
    { type: "skill", name: "qa", source: "project", content: "# QA skill\nRun the tests." },
    { type: "instructions", name: "CLAUDE.md", content: "Always QA before shipping." },
  ],
  checks: [],
  requiredSecrets: [],
};

// A fake agent that records the descriptor + cwd it was driven with, and replays a canned result.
function fakeAgent(result: RunResult) {
  const calls = { cwd: null as string | null, command: null as string | null };
  const connectFn: RunConnectFn = async (descriptor) => ({
    ctx: {
      async open(cwd: string) {
        calls.cwd = cwd;
        calls.command = descriptor.command.join(" ");
        return {
          async setMode() {},
          async prompt() { return result; },
          dispose() {},
        };
      },
    },
    close() {},
  });
  return { connectFn, calls };
}

describe("materializeGemToTestbed", () => {
  it("writes the gem's skill into the runnable .claude/skills layout", () => {
    const dir = tmp();
    const res = materializeGemToTestbed(gem, dir);
    const skillPath = join(dir, ".claude", "skills", "qa", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    expect(readFileSync(skillPath, "utf8")).toContain("Run the tests.");
    expect(res.written.some((w) => w.type === "skill" && w.name === "qa")).toBe(true);
  });

  it("folds the gem's instructions into CLAUDE.md", () => {
    const dir = tmp();
    materializeGemToTestbed(gem, dir);
    const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("Always QA before shipping.");
  });
});

describe("materializeAndRunGem", () => {
  it("materializes into dir, then runs the agent in that same dir", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "done", toolCalls: [{ toolCallId: "t1", title: "Skill(qa)", status: "completed" }] });
    const out = await materializeAndRunGem({ gem, dir, task: "run qa", connectFn });
    expect(existsSync(join(dir, ".claude", "skills", "qa", "SKILL.md"))).toBe(true); // materialized
    expect(calls.cwd).toBe(dir);                                                     // ran in that dir
    expect(out.run.ok).toBe(true);
    expect(out.run.result.toolCalls[0].title).toBe("Skill(qa)");
  });

  it("attaches a verification report when expectations are supplied", async () => {
    const dir = tmp();
    const { connectFn } = fakeAgent({ text: "qa complete", toolCalls: [{ toolCallId: "t1", title: "Skill(qa)", status: "completed" }] });
    const out = await materializeAndRunGem({
      gem, dir, task: "run qa", connectFn,
      expectations: { expectTools: ["qa"], expectText: /complete/i },
    });
    expect(out.verification?.passed).toBe(true);
  });

  it("omits verification when no expectations are supplied", async () => {
    const dir = tmp();
    const { connectFn } = fakeAgent({ text: "done", toolCalls: [] });
    const out = await materializeAndRunGem({ gem, dir, task: "go", connectFn });
    expect(out.verification).toBeUndefined();
  });

  it("defaults to the Claude adapter", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "", toolCalls: [] });
    const out = await materializeAndRunGem({ gem, dir, task: "go", connectFn });
    expect(calls.command).toContain("claude-agent-acp");
    expect(out.agent).toBe("claude");
  });

  it("selects the codex adapter and materializes to the codex flavor", async () => {
    const dir = tmp();
    const { connectFn, calls } = fakeAgent({ text: "", toolCalls: [] });
    await materializeAndRunGem({ gem, dir, task: "go", agent: "codex", connectFn });
    expect(calls.command).toContain("codex-acp"); // bare PATH name, or resolved [node, …/codex-acp/…]
    // codex flavor writes skills under .agents/skills, not .claude/skills
    expect(existsSync(join(dir, ".agents", "skills", "qa", "SKILL.md"))).toBe(true);
  });
});

describe("run registry", () => {
  it("registers a runDir + agent under an opaque id and resolves it", () => {
    const id = registerRun("/tmp/some-run-dir", "claude");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThanOrEqual(8);
    expect(resolveRun(id)).toEqual({ dir: "/tmp/some-run-dir", agent: "claude" });
  });

  it("returns undefined for an unknown id (no path leaks through)", () => {
    expect(resolveRun("not-a-real-id")).toBeUndefined();
  });

  it("issues distinct ids for distinct runs", () => {
    const a = registerRun("/tmp/a", "claude");
    const b = registerRun("/tmp/b", "codex");
    expect(a).not.toBe(b);
    expect(resolveRun(b)).toEqual({ dir: "/tmp/b", agent: "codex" });
  });
});

describe("resolveAdapterCommand", () => {
  it("falls back to the bare binary name (PATH) when the package isn't installed locally", () => {
    expect(resolveAdapterCommand("@agentclientprotocol/does-not-exist", "ghost-acp")).toEqual(["ghost-acp"]);
  });

  it("resolves an installed package to [node, <bin path>] so no global install is needed", () => {
    // The SDK is always a local dep and ships a bin-less package, so use a package
    // we know resolves; assert the shape: either [node, path-with-name] or PATH fallback.
    const cmd = resolveAdapterCommand("@agentclientprotocol/codex-acp", "codex-acp");
    if (cmd.length === 2) {
      expect(cmd[0]).toBe(process.execPath);
      expect(cmd[1]).toContain("codex-acp");
    } else {
      expect(cmd).toEqual(["codex-acp"]); // not installed locally in this env → PATH fallback
    }
  });
});

describe("resolveOrFetchAdapter", () => {
  const tmps2: string[] = [];
  let prevHome: string | undefined;
  function tmpHome() {
    const h = mkdtempSync(join(tmpdir(), "agh-adapt-"));
    tmps2.push(h);
    prevHome = process.env.AGENTGEM_HOME;
    process.env.AGENTGEM_HOME = h;
    return h;
  }
  afterEach(() => {
    if (prevHome !== undefined) process.env.AGENTGEM_HOME = prevHome; else delete process.env.AGENTGEM_HOME;
    for (const d of tmps2.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("fetches on demand into the AGENTGEM_HOME cache, then resolves the bin", async () => {
    tmpHome();
    let calls = 0;
    const installer: AdapterInstaller = async (_p, _v, prefix) => { calls++; installFakeInto(prefix); };
    let fetched = false;
    const cmd = await resolveOrFetchAdapter(FAKE_ADAPTER, { installer, onFetch: () => { fetched = true; } });
    expect(calls).toBe(1);
    expect(fetched).toBe(true);
    expect(cmd[0]).toBe(process.execPath);
    expect(cmd[1]).toContain("fake-acp-pkg");
  });

  it("uses the cache without re-fetching on the next call", async () => {
    tmpHome();
    installFakeInto(adapterCacheDir());
    let calls = 0;
    const cmd = await resolveOrFetchAdapter(FAKE_ADAPTER, { installer: async () => { calls++; } });
    expect(calls).toBe(0);
    expect(cmd[1]).toContain("fake-acp-pkg");
  });

  it("dedupes concurrent fetches — the installer runs once", async () => {
    tmpHome();
    let calls = 0;
    const installer: AdapterInstaller = async (_p, _v, prefix) => { calls++; await new Promise((r) => setTimeout(r, 20)); installFakeInto(prefix); };
    const [a, b] = await Promise.all([resolveOrFetchAdapter(FAKE_ADAPTER, { installer }), resolveOrFetchAdapter(FAKE_ADAPTER, { installer })]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("throws instead of fetching when allowFetch is false (offline)", async () => {
    tmpHome();
    await expect(resolveOrFetchAdapter(FAKE_ADAPTER, { allowFetch: false })).rejects.toThrow(/not installed/i);
  });
});

describe("AGENT_ADAPTERS", () => {
  it("maps each agent id to an adapter package + testbed flavor; both validated", () => {
    expect(AGENT_ADAPTERS.claude.flavor).toBe("claude");
    expect(AGENT_ADAPTERS.claude.pkg).toContain("claude-agent-acp");
    expect(AGENT_ADAPTERS.claude.bin).toBe("claude-agent-acp");
    expect(AGENT_ADAPTERS.claude.validated).toBe(true);
    expect(AGENT_ADAPTERS.codex.flavor).toBe("codex");
    expect(AGENT_ADAPTERS.codex.pkg).toContain("codex-acp");
    expect(AGENT_ADAPTERS.codex.bin).toBe("codex-acp");
    expect(AGENT_ADAPTERS.codex.validated).toBe(true);
  });
});
