import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../workspaces.js";
import type { Gem } from "../types.js";
import type { ProcessRunner, ProcHandle } from "../run.js";
import {
  resolveAgentcoreBin, agentcoreReadiness, parseAgentcoreEndpoint,
  deployAgentcore, getAgentcoreStatus,
} from "../agentcoreRun.js";

function fakeRunner() {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const handles: { lineCbs: Function[]; exitCbs: Function[]; killed: boolean }[] = [];
  const runner: ProcessRunner = {
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const h = { lineCbs: [] as Function[], exitCbs: [] as Function[], killed: false };
      handles.push(h);
      const handle: ProcHandle = { onLine: (cb) => h.lineCbs.push(cb), onExit: (cb) => h.exitCbs.push(cb), kill: () => { h.killed = true; } };
      return handle;
    },
  };
  return { runner, calls, handles };
}
function seedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agentgem-ac-"));
  process.env.AGENTGEM_HOME = root;
  const gem: Gem = { name: "gem", createdFrom: "/d", artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# body\n" }], checks: [], requiredSecrets: [] };
  createWorkspace("gem", gem);
  return join(root, "workspaces", "gem");
}
const savedEnv = { ...process.env };
afterEach(() => { process.env = { ...savedEnv }; });

describe("agentcore pure helpers", () => {
  it("agentcoreReadiness reports cli + awsCreds booleans from env", () => {
    // Empty PATH so the bin scan can't find a host-installed `agentcore` (keeps the test deterministic).
    delete process.env.AGENTCORE_BIN; delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_PROFILE; process.env.PATH = "";
    expect(agentcoreReadiness()).toEqual({ cli: false, awsCreds: false });
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    expect(agentcoreReadiness().awsCreds).toBe(true);
  });
  it("resolveAgentcoreBin honors AGENTCORE_BIN when the path exists", () => {
    process.env.AGENTCORE_BIN = "/usr/bin/env"; // a path that exists on the test host
    expect(resolveAgentcoreBin()).toBe("/usr/bin/env");
  });
  it("parseAgentcoreEndpoint prefers a harness ARN, falls back to a URL", () => {
    expect(parseAgentcoreEndpoint(["deploying…", "Created arn:aws:bedrock-agentcore:us-west-2:123:harness/Gem-Ab12"])).toMatch(/^arn:aws:bedrock-agentcore:.*harness\/Gem-Ab12$/);
    expect(parseAgentcoreEndpoint(["see https://x.example/console"])).toBe("https://x.example/console");
    expect(parseAgentcoreEndpoint(["nothing"])).toBeUndefined();
  });
});

describe("deployAgentcore", () => {
  it("rejects when AWS creds are missing", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env";
    delete process.env.AWS_ACCESS_KEY_ID; delete process.env.AWS_PROFILE;
    const { runner } = fakeRunner();
    await expect(deployAgentcore("gem", runner)).rejects.toThrow(/AWS/);
  });

  it("shells `agentcore deploy` in .run/agentcore and parses the endpoint", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env";
    process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    const { runner, calls, handles } = fakeRunner();
    const p = deployAgentcore("gem", runner);
    await Promise.resolve(); await Promise.resolve(); // let ensureAgentcoreProject (no spawn) + first spawn happen
    expect(calls[0].cmd).toBe("/usr/bin/env");
    expect(calls[0].args).toContain("deploy");
    expect(calls[0].cwd.endsWith(join(".run", "agentcore"))).toBe(true);
    handles[0].lineCbs.forEach((cb) => cb("Created arn:aws:bedrock-agentcore:us-west-2:123:harness/Gem-Ab12", "out"));
    handles[0].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.state).toBe("idle");
    expect(state.url).toMatch(/harness\/Gem-Ab12$/);
    expect(getAgentcoreStatus("gem").state).toBe("idle");
  });

  it("marks failed when the CLI exits non-zero", async () => {
    seedWorkspace();
    process.env.AGENTCORE_BIN = "/usr/bin/env"; process.env.AWS_PROFILE = "default"; process.env.AWS_REGION = "us-west-2";
    const { runner, handles } = fakeRunner();
    const p = deployAgentcore("gem", runner);
    await Promise.resolve(); await Promise.resolve();
    handles[0].exitCbs.forEach((cb) => cb(1));
    expect((await p).state).toBe("failed");
  });
});
