// src/gem/__tests__/run.test.ts
import { describe, it, expect } from "vitest";
import { pushLog, nodeMajor, parseEveUrl, parseVercelUrl, parseSingleTeamScope, parseWorkersUrl, runReadiness, deployCloudflare, undeployCloudflare } from "../run.js";
import { startLocal, stopLocal, getRunStatus, deployVercel, undeployVercel, vercelProject, type ProcessRunner, type ProcHandle } from "../run.js";
import { readDeployRecord, writeDeployRecord } from "../deployRecord.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../workspaces.js";
import type { Gem } from "../types.js";

describe("run pure helpers", () => {
  it("pushLog caps the buffer at 200 lines (drops oldest)", () => {
    const buf: string[] = [];
    for (let i = 0; i < 250; i++) pushLog(buf, `line ${i}`);
    expect(buf.length).toBe(200);
    expect(buf[0]).toBe("line 50");
    expect(buf[199]).toBe("line 249");
  });

  it("nodeMajor parses the major version", () => {
    expect(nodeMajor("v24.13.0")).toBe(24);
    expect(nodeMajor("18.0.0")).toBe(18);
    expect(nodeMajor("garbage")).toBe(0);
  });

  it("parseEveUrl returns the first http(s) URL in the lines", () => {
    expect(parseEveUrl(["starting…", "Listening on http://127.0.0.1:3000"])).toBe("http://127.0.0.1:3000");
    expect(parseEveUrl(["no url here"])).toBeUndefined();
  });

  it("parseVercelUrl returns the deployment .vercel.app URL", () => {
    expect(parseVercelUrl(["Inspect: x", "https://gem-abc123.vercel.app"])).toBe("https://gem-abc123.vercel.app");
    expect(parseVercelUrl(["http://localhost:3000"])).toBeUndefined();
  });

  it("parseWorkersUrl grabs the workers.dev URL from wrangler output", () => {
    expect(parseWorkersUrl(["Uploaded", "https://my-gem.acct.workers.dev", "Done"]))
      .toBe("https://my-gem.acct.workers.dev");
    expect(parseWorkersUrl(["no url here"])).toBeUndefined();
  });

  it("vercelProject slugs the gem name and never yields a trailing-dash/empty project", () => {
    expect(vercelProject("demo-gem")).toBe("eve-demo-gem");
    expect(vercelProject("My Gem!")).toBe("eve-my-gem");
    expect(vercelProject("---")).toBe("eve-agent"); // all-non-alnum -> fallback, not "eve-"
  });

  it("parseSingleTeamScope extracts the lone team from a missing_scope response", () => {
    const lines = JSON.stringify({ reason: "missing_scope", choices: [{ id: "t", name: "ninemind" }] }, null, 2).split("\n");
    expect(parseSingleTeamScope(lines)).toBe("ninemind");
  });

  it("parseSingleTeamScope returns undefined for multiple teams or normal output", () => {
    const multi = JSON.stringify({ reason: "missing_scope", choices: [{ name: "a" }, { name: "b" }] }, null, 2).split("\n");
    expect(parseSingleTeamScope(multi)).toBeUndefined();
    expect(parseSingleTeamScope(["Deploying…", "https://x.vercel.app"])).toBeUndefined();
  });
});

// A fake runner that records spawns and lets the test drive lines/exit.
function fakeRunner() {
  const calls: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
  const handles: { lineCbs: Function[]; exitCbs: Function[]; killed: boolean }[] = [];
  const runner: ProcessRunner = {
    spawn(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts.cwd, env: opts.env });
      const h = { lineCbs: [] as Function[], exitCbs: [] as Function[], killed: false };
      handles.push(h);
      const handle: ProcHandle = {
        onLine: (cb) => { h.lineCbs.push(cb); },
        onExit: (cb) => { h.exitCbs.push(cb); },
        kill: () => { h.killed = true; },
      };
      return handle;
    },
  };
  return { runner, calls, handles };
}

// A minimal workspace on disk using createWorkspace so gem.json + gem.lock are in archive format.
function seedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "agentgem-run-"));
  process.env.AGENTGEM_HOME = root;
  const gem: Gem = {
    name: "gem", createdFrom: "/d",
    artifacts: [{ type: "skill", name: "review", source: "standalone", content: "# body\n" }],
    checks: [], requiredSecrets: [],
  };
  createWorkspace("gem", gem);
  return join(root, "workspaces", "gem");
}

describe("local run", () => {
  it("startLocal installs, builds, then starts and parses the URL", async () => {
    seedWorkspace();
    const { runner, calls, handles } = fakeRunner();
    const p = startLocal("gem", runner);
    // 1st spawn = npm install; complete it
    await Promise.resolve();
    expect(calls[0].cmd).toBe("npm");
    expect(calls[0].args).toContain("install");
    handles[0].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve(); await Promise.resolve();
    // 2nd spawn = eve build; complete it
    expect(calls[1].args).toContain("build");
    handles[1].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve(); await Promise.resolve();
    // 3rd spawn = eve start; emit a URL line
    expect(calls[2].args).toContain("start");
    handles[2].lineCbs.forEach((cb) => cb("Listening on http://127.0.0.1:3000", "out"));
    const state = await p;
    expect(state.state).toBe("running");
    expect(state.url).toBe("http://127.0.0.1:3000");
    // stop kills the start child
    expect(stopLocal("gem", "eve").stopped).toBe(true);
    expect(handles[2].killed).toBe(true);
    expect(getRunStatus("gem", "eve").state).toBe("idle");
  });

  it("startLocal marks failed when eve build exits non-zero", async () => {
    seedWorkspace();
    const { runner, handles } = fakeRunner();
    const p = startLocal("gem", runner);
    handles[0].exitCbs.forEach((cb) => cb(0)); // install ok
    await Promise.resolve(); await Promise.resolve();
    handles[1].exitCbs.forEach((cb) => cb(1)); // build fails
    await Promise.resolve(); await Promise.resolve();
    const state = await p;
    expect(state.state).toBe("failed");
  });
});

describe("vercel deploy", () => {
  it("throws when VERCEL_TOKEN is unset", async () => {
    seedWorkspace();
    delete process.env.VERCEL_TOKEN;
    const { runner } = fakeRunner();
    await expect(deployVercel("gem", runner)).rejects.toThrow(/VERCEL_TOKEN/);
  });

  it("deploys from source (no --prebuilt) with the token and parses the URL", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test";
    delete process.env.VERCEL_SCOPE;
    const { runner, calls, handles } = fakeRunner();
    const p = deployVercel("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // npm install
    await Promise.resolve(); await Promise.resolve();
    // no local eve build; calls[1] = vercel deploy --yes --token=tok_test (from source, no scope)
    expect(calls[1].args).toEqual(["deploy", "--yes", "--token=tok_test"]);
    handles[1].lineCbs.forEach((cb) => cb("https://gem-abc123.vercel.app", "out"));
    handles[1].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.mode).toBe("vercel");
    expect(state.state).toBe("idle");
    expect(state.url).toBe("https://gem-abc123.vercel.app");
    delete process.env.VERCEL_TOKEN;
  });

  it("retries with --scope when the CLI refuses with a single team", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test";
    delete process.env.VERCEL_SCOPE;
    const { runner, calls, handles } = fakeRunner();
    const p = deployVercel("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // npm install
    await Promise.resolve(); await Promise.resolve();
    // first deploy (no scope) -> emits the missing_scope JSON and exits non-zero
    expect(calls[1].args).toEqual(["deploy", "--yes", "--token=tok_test"]);
    JSON.stringify({ reason: "missing_scope", choices: [{ id: "team_x", name: "ninemind" }] }, null, 2)
      .split("\n").forEach((l) => handles[1].lineCbs.forEach((cb) => cb(l, "out")));
    handles[1].exitCbs.forEach((cb) => cb(1));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    // retry carries --scope=ninemind
    expect(calls[2].args).toEqual(["deploy", "--yes", "--token=tok_test", "--scope=ninemind"]);
    handles[2].lineCbs.forEach((cb) => cb("https://gem-xyz.vercel.app", "out"));
    handles[2].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.state).toBe("idle");
    expect(state.url).toBe("https://gem-xyz.vercel.app");
    delete process.env.VERCEL_TOKEN;
  });
});

describe("vercel deploy record + undeploy", () => {
  it("records the project + url on a successful deploy", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test"; delete process.env.VERCEL_SCOPE;
    const { runner, handles } = fakeRunner();
    const p = deployVercel("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // install
    await Promise.resolve(); await Promise.resolve();
    handles[1].lineCbs.forEach((cb) => cb("https://eve-gem-abc.vercel.app", "out"));
    handles[1].exitCbs.forEach((cb) => cb(0));
    await p;
    const rec = readDeployRecord("gem", "eve");
    expect(rec?.url).toBe("https://eve-gem-abc.vercel.app");
    expect(rec?.project).toBe("eve-gem");
    delete process.env.VERCEL_TOKEN;
  });

  it("undeployVercel runs vercel remove for the recorded project and clears the record", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test"; delete process.env.VERCEL_SCOPE;
    writeDeployRecord("gem", { backend: "eve", project: "eve-gem", url: "https://x.vercel.app" });
    const { runner, calls, handles } = fakeRunner();
    const up = undeployVercel("gem", runner);
    await Promise.resolve();
    expect(calls[0].args).toEqual(["remove", "eve-gem", "--yes", "--token=tok_test"]);
    handles[0].exitCbs.forEach((cb) => cb(0));
    const r = await up;
    expect(r.removed).toBe(true);
    expect(readDeployRecord("gem", "eve")).toBeNull();
    delete process.env.VERCEL_TOKEN;
  });

  it("undeployVercel fails safe when nothing is recorded", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test";
    const { runner } = fakeRunner();
    await expect(undeployVercel("gem", runner)).rejects.toThrow(/no .*deploy/i);
    delete process.env.VERCEL_TOKEN;
  });
});

describe("runReadiness cloudflare gate", () => {
  it("reports cloudflare true only when CLOUDFLARE_API_TOKEN is set", () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    try {
      delete process.env.CLOUDFLARE_API_TOKEN;
      expect(runReadiness().cloudflare).toBe(false);
      process.env.CLOUDFLARE_API_TOKEN = "t";
      expect(runReadiness().cloudflare).toBe(true);
    } finally { if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev; else delete process.env.CLOUDFLARE_API_TOKEN; }
  });
});

describe("deployCloudflare", () => {
  it("fails fast without CLOUDFLARE_API_TOKEN", async () => {
    const prev = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      await expect(deployCloudflare("nope")).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    } finally { if (prev !== undefined) process.env.CLOUDFLARE_API_TOKEN = prev; }
  });

  it("installs, runs flue build, deploys via wrangler, and parses the workers URL", async () => {
    seedWorkspace();
    process.env.CLOUDFLARE_API_TOKEN = "cf_test_token";
    const { runner, calls, handles } = fakeRunner();
    const p = deployCloudflare("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // npm install
    await Promise.resolve(); await Promise.resolve();
    // flue build --target cloudflare
    const build = calls[1];
    expect(build.args).toEqual(["build", "--target", "cloudflare"]);
    handles[1].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve();
    // wrangler deploy
    const deploy = calls[2];
    expect(deploy.args).toEqual(["deploy"]);
    expect(deploy.env.CLOUDFLARE_API_TOKEN).toBe("cf_test_token");
    handles[2].lineCbs.forEach((cb) => cb("https://my-gem.acct.workers.dev", "out"));
    handles[2].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.mode).toBe("cloudflare");
    expect(state.state).toBe("idle");
    expect(state.url).toBe("https://my-gem.acct.workers.dev");
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  it("records the worker + url on a successful deploy", async () => {
    seedWorkspace();
    process.env.CLOUDFLARE_API_TOKEN = "cf_test_token";
    const { runner, handles } = fakeRunner();
    const p = deployCloudflare("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // install
    await Promise.resolve(); await Promise.resolve();
    handles[1].exitCbs.forEach((cb) => cb(0)); // flue build
    await Promise.resolve();
    handles[2].lineCbs.forEach((cb) => cb("https://gem.acct.workers.dev", "out"));
    handles[2].exitCbs.forEach((cb) => cb(0));
    await p;
    const rec = readDeployRecord("gem", "flue");
    expect(rec?.worker).toBe("gem");
    expect(rec?.url).toBe("https://gem.acct.workers.dev");
    delete process.env.CLOUDFLARE_API_TOKEN;
  });
});

describe("undeployCloudflare", () => {
  it("undeployCloudflare runs wrangler delete for the recorded worker and clears the record", async () => {
    seedWorkspace();
    process.env.CLOUDFLARE_API_TOKEN = "cf";
    writeDeployRecord("gem", { backend: "flue", worker: "gem", url: "https://gem.acct.workers.dev" });
    const { runner, calls, handles } = fakeRunner();
    const up = undeployCloudflare("gem", runner);
    await Promise.resolve();
    expect(calls[0].args).toEqual(["delete", "--name", "gem", "--force"]);
    handles[0].exitCbs.forEach((cb) => cb(0));
    const r = await up;
    expect(r.removed).toBe(true);
    expect(readDeployRecord("gem", "flue")).toBeNull();
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  it("undeployCloudflare fails safe when nothing recorded / no token", async () => {
    seedWorkspace();
    delete process.env.CLOUDFLARE_API_TOKEN;
    const { runner } = fakeRunner();
    await expect(undeployCloudflare("gem", runner)).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  });
});
