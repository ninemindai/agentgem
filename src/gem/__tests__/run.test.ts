// src/gem/__tests__/run.test.ts
import { describe, it, expect } from "vitest";
import { pushLog, nodeMajor, parseEveUrl, parseVercelUrl, parseWorkersUrl, runReadiness, deployCloudflare } from "../run.js";
import { startLocal, stopLocal, getRunStatus, deployVercel, type ProcessRunner, type ProcHandle } from "../run.js";
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

  it("builds with VERCEL=1, then deploys with the token, and parses the URL", async () => {
    seedWorkspace();
    process.env.VERCEL_TOKEN = "tok_test";
    const { runner, calls, handles } = fakeRunner();
    const p = deployVercel("gem", runner);
    await Promise.resolve(); handles[0].exitCbs.forEach((cb) => cb(0)); // npm install
    await Promise.resolve(); await Promise.resolve();
    // eve build with VERCEL=1
    const build = calls[1];
    expect(build.args).toContain("build");
    expect(build.env.VERCEL).toBe("1");
    handles[1].exitCbs.forEach((cb) => cb(0));
    await Promise.resolve();
    // vercel deploy --prebuilt --yes --token=tok_test
    const deploy = calls[2];
    expect(deploy.args).toEqual(["deploy", "--prebuilt", "--yes", "--token=tok_test"]);
    handles[2].lineCbs.forEach((cb) => cb("https://gem-abc123.vercel.app", "out"));
    handles[2].exitCbs.forEach((cb) => cb(0));
    const state = await p;
    expect(state.mode).toBe("vercel");
    expect(state.state).toBe("idle");
    expect(state.url).toBe("https://gem-abc123.vercel.app");
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
});
