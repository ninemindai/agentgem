// src/__tests__/gem.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { unpackTar } from "../gem/archiveTar.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let dir: string;
let projRoot: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ap-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\n");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_secret" } } } }));
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");

  projRoot = mkdtempSync(join(tmpdir(), "proj-"));
  mkdirSync(join(projRoot, ".claude", "skills", "deploy"), { recursive: true });
  writeFileSync(join(projRoot, ".claude", "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Project deploy\n---\n# Deploy\n");
  writeFileSync(join(projRoot, ".mcp.json"), JSON.stringify({ db: { command: "pg", env: { PW: "projsecret" } } }));
  writeFileSync(join(projRoot, "CLAUDE.md"), "project instructions");

  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(projRoot, { recursive: true, force: true });
});

describe("GemController", () => {
  it("GET /api/inventory returns redacted inventory", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills.map((s: { name: string }) => s.name)).toEqual(["review"]);
    expect(r.body.mcpServers[0].config.env.GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
    expect(r.body.skills[0].source).toBe("standalone");
    expect(r.body.mcpServers[0].source).toBe("user");
  });

  it("POST /api/gem builds a gem from a selection", async () => {
    const r = await client.post("/api/gem")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo" })
      .expect(200);
    expect(r.body.name).toBe("demo");
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["review", "CLAUDE.md"]);
  });

  it("POST /api/publish-preview renders the agent payload, skips stdio MCP, leaks no secret", async () => {
    const r = await client.post("/api/publish-preview")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "pub" })
      .expect(200);
    expect(r.body.payload.name).toBe("pub");
    expect(r.body.payload.model).toBe("claude-opus-4-8");
    expect(r.body.payload.system).toContain("global instructions");
    expect(r.body.payload.system).not.toContain("# Skill:"); // skills are registered, not inlined
    expect(r.body.skillsToRegister).toEqual(["review"]);
    // gh is a stdio (command) server -> skipped; its vault secret is filtered out too
    expect(r.body.payload.mcp_servers).toEqual([]);
    expect(r.body.skipped.find((s: { artifact: string }) => s.artifact === "gh").reason).toMatch(/stdio MCP/);
    expect(r.body.vaultSecrets).toEqual([]);
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
  });

  it("GET /api/publish-ready reports key presence as a boolean", async () => {
    const r = await client.get("/api/publish-ready").expect(200);
    expect(typeof r.body.ready).toBe("boolean");
  });

  it("GET /api/inventory?projects= returns a redacted project section with a name", async () => {
    const r = await client
      .get(`/api/inventory?dir=${encodeURIComponent(dir)}&projects=${encodeURIComponent(JSON.stringify([projRoot]))}`)
      .expect(200);
    expect(r.body.projects).toHaveLength(1);
    const proj = r.body.projects[0];
    expect(proj.root).toBe(projRoot);
    expect(proj.name).toBe(projRoot.split("/").pop());
    expect(proj.skills.map((s: { name: string }) => s.name)).toEqual(["deploy"]);
    expect(proj.skills[0].source).toBe("project");
    expect(proj.mcpServers[0].config.env.PW).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("projsecret");
  });

  it("POST /api/gem includes selected artifacts from the keyed project", async () => {
    const r = await client.post("/api/gem")
      .send({ dir, projects: [projRoot], selection: { projects: { [projRoot]: { skills: ["deploy"], includeInstructions: true } } }, name: "p" })
      .expect(200);
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["deploy", "CLAUDE.md"]);
  });

  it("POST /api/gem embeds checks and declares requiredSecrets (names, not values)", async () => {
    const r = await client
      .post("/api/gem")
      .send({
        dir,
        selection: { skills: ["review"], mcpServers: ["gh"] },
        checks: [{ kind: "behavioral", name: "smoke", task: "do it with ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", assertions: [] }],
      })
      .expect(200);
    expect(r.body.checks.map((c: { name: string }) => c.name)).toEqual(["smoke"]);
    expect(r.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // MCP secret value never present
    expect(JSON.stringify(r.body.checks)).not.toContain("ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"); // check text redacted too
  });

  it("POST /api/scaffold-checks returns editable drafts (behavioral + skillspector for a skill)", async () => {
    const r = await client.post("/api/scaffold-checks").send({ dir, selection: { skills: ["review"] } }).expect(200);
    const kinds = r.body.checks.map((c: { kind: string }) => c.kind);
    expect(kinds).toContain("behavioral");
    expect(kinds).toContain("external");
  });

  it("POST /api/materialize renders the target layout + compatibility, no secret values", async () => {
    const r = await client
      .post("/api/materialize")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"] }, target: "codex" })
      .expect(200);
    expect(r.body.target).toBe("codex");
    expect(r.body.files["skills/review/SKILL.md"]).toBeTruthy();
    expect(r.body.files["config.toml"]).toContain("[mcp_servers.gh]");
    expect(r.body.compatibility.codex).toBeTruthy();
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // secret value never present
  });
});

describe("POST /api/archive", () => {
  it("returns a manifest+lock tree and writes it to outDir", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch-"));
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "demo", version: "2.0.0", outDir: out })
      .expect(200);
    expect(r.body.files["skills/review/SKILL.md"]).toContain("# Review");
    expect(JSON.parse(r.body.files["gem.json"]).version).toBe("2.0.0");
    expect(r.body.lock.gemDigest).toMatch(/^sha256:/);
    expect(r.body.path).toBe(out);
    expect(r.body.files["mcp/gh.json"]).toBeDefined();
    expect(r.body.files["mcp/gh.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // redaction survives
    expect(r.body.tarGz).toBeNull(); // no tar unless requested
    rmSync(out, { recursive: true, force: true });
  });

  it("returns a base64 .tar.gz when tar:true that unpacks back to the same tree", async () => {
    const r = await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "demo", tar: true })
      .expect(200);
    expect(typeof r.body.tarGz).toBe("string");
    expect(r.body.path).toBeNull(); // tar requested but no outDir -> nothing written to disk
    const unpacked = unpackTar(Buffer.from(r.body.tarGz, "base64"));
    expect(unpacked).toEqual(r.body.files); // round-trips the exact archive tree
    expect(unpacked["mcp/gh.json"]).toContain("<redacted>");
    expect(JSON.stringify(unpacked)).not.toContain("ghp_secret"); // tarball is secret-safe too
  });
});

describe("POST /api/materialize from an archive", () => {
  it("renders an Eve project from a written archive (no live introspection)", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch2-"));
    await client.post("/api/archive")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, outDir: out })
      .expect(200);

    const r = await client.post("/api/materialize")
      .send({ archivePath: out, target: "eve" })
      .expect(200);

    expect(r.body.target).toBe("eve");
    expect(r.body.files["agent/skills/review.md"]).toContain("# Review");
    expect(r.body.files["agent/instructions.md"]).toBeDefined();
    rmSync(out, { recursive: true, force: true });
  });

  it("rejects a tampered archive", async () => {
    const out = mkdtempSync(join(tmpdir(), "arch3-"));
    await client.post("/api/archive").send({ dir, selection: { skills: ["review"] }, outDir: out }).expect(200);
    writeFileSync(join(out, "skills", "review", "SKILL.md"), "# tampered");
    await client.post("/api/materialize").send({ archivePath: out, target: "claude" }).expect(500);
    rmSync(out, { recursive: true, force: true });
  });
});

describe("deploy registry ops", () => {
  it("GET /api/deploy-targets lists claude-managed with a boolean ready", async () => {
    const r = await client.get("/api/deploy-targets").expect(200);
    expect(r.body.targets.map((t: { id: string }) => t.id)).toEqual(["claude-managed"]);
    expect(typeof r.body.targets[0].ready).toBe("boolean");
  });

  it("publish-preview routes through the registry (target optional, identical payload)", async () => {
    const base = { dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true }, name: "pub" };
    const a = await client.post("/api/publish-preview").send(base).expect(200);
    const b = await client.post("/api/publish-preview").send({ ...base, target: "claude-managed" }).expect(200);
    expect(a.body.payload.name).toBe("pub");
    expect(a.body).toEqual(b.body);
    expect(JSON.stringify(a.body)).not.toContain("ghp_secret");
  });

  it("POST /api/publish without ANTHROPIC_API_KEY returns 500 (gated via the registry)", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await client.post("/api/publish").send({ dir, selection: { skills: ["review"] }, requestId: "req-12345678" }).expect(500);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("publish-preview is tagged kind=managed-agent", async () => {
    const r = await client.post("/api/publish-preview")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "pub" }).expect(200);
    expect(r.body.kind).toBe("managed-agent");
    expect(r.body.payload.name).toBe("pub");           // existing managed-agent fields still present
    expect(Array.isArray(r.body.skillsToRegister)).toBe(true);
  });
});

describe("testbed ops", () => {
  it("scaffold then import (raw MCP) — testbed runs, packaged gem stays redacted", async () => {
    const tb = mkdtempSync(join(tmpdir(), "tb-"));
    try {
      const sc = await client.post("/api/testbed/scaffold").send({ root: tb, name: "agent" }).expect(200);
      expect(sc.body.created).toContain("CLAUDE.md");

      // `dir` points at the global config fixture built in beforeAll (has mcp `gh` with ghp_secret)
      const im = await client.post("/api/testbed/import")
        .send({ root: tb, dir, selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(im.body.written.map((w: { name: string }) => w.name).sort()).toContain("gh");

      // testbed .mcp.json holds the RAW secret (so `claude` runs there)
      const mcp = JSON.parse(readFileSync(join(tb, ".mcp.json"), "utf8"));
      expect(mcp.mcpServers.gh.env.GH_TOKEN).toBe("ghp_secret");

      // but packaging the testbed yields a redacted gem
      const g = await client.post("/api/gem")
        .send({ projects: [tb], selection: { projects: { [tb]: { skills: ["review"], mcpServers: ["gh"] } } }, name: "p" })
        .expect(200);
      expect(JSON.stringify(g.body)).not.toContain("ghp_secret");
      expect(g.body.requiredSecrets).toContainEqual({ name: "GH_TOKEN", artifact: "gh", location: "env.GH_TOKEN" });
    } finally {
      rmSync(tb, { recursive: true, force: true });
    }
  });
});

describe("run ops", () => {
  it("GET /api/run-ready returns booleans", async () => {
    const res = await client.get("/api/run-ready").query({ name: "gem", target: "eve" });
    expect(res.status).toBe(200);
    expect(typeof res.body.local).toBe("boolean");
    expect(typeof res.body.vercel).toBe("boolean");
  });

  it("POST /api/run mode=vercel without VERCEL_TOKEN is rejected", async () => {
    delete process.env.VERCEL_TOKEN;
    const res = await client.post("/api/run").send({ name: "gem", target: "eve", mode: "vercel" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe("workspace ops", () => {
  it("create -> list -> render(eve) -> read -> delete", async () => {
    const home = mkdtempSync(join(tmpdir(), "wsh-"));
    process.env.AGENTGEM_HOME = home;
    try {
      const c = await client.post("/api/workspaces")
        .send({ dir, name: "mp", selection: { skills: ["review"], mcpServers: ["gh"], includeInstructions: true } })
        .expect(200);
      expect(c.body.name).toBe("mp");
      expect(c.body.artifactCounts.skill).toBe(1);

      const l = await client.get("/api/workspaces").expect(200);
      expect(l.body.workspaces.map((w: { name: string }) => w.name)).toEqual(["mp"]);

      const r = await client.post("/api/workspace/render").send({ name: "mp", target: "eve" }).expect(200);
      expect(r.body.files["agent/skills/review.md"]).toContain("# Review");

      const d = await client.get("/api/workspace?name=mp").expect(200);
      expect(d.body.renderedTargets).toEqual(["eve"]);
      expect(JSON.stringify(d.body)).not.toContain("ghp_secret"); // redaction survives

      const del = await client.post("/api/workspace/delete").send({ name: "mp" }).expect(200);
      expect(del.body.deleted).toBe("mp");
      expect((await client.get("/api/workspaces").expect(200)).body.workspaces).toEqual([]);
    } finally {
      delete process.env.AGENTGEM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("agentcore deploy ops", () => {
  it("GET /api/agentcore/deploy-ready returns booleans", async () => {
    const r = await client.get("/api/agentcore/deploy-ready").expect(200);
    expect(typeof r.body.cli).toBe("boolean");
    expect(typeof r.body.awsCreds).toBe("boolean");
  });

  it("POST /api/agentcore/deploy without AWS creds is rejected", async () => {
    const savedP = process.env.AWS_PROFILE, savedK = process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_PROFILE; delete process.env.AWS_ACCESS_KEY_ID;
    process.env.AGENTCORE_BIN = "/usr/bin/env"; // CLI present so the failure is specifically the creds gate
    try {
      const res = await client.post("/api/agentcore/deploy").send({ name: "gem" });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      if (savedP !== undefined) process.env.AWS_PROFILE = savedP;
      if (savedK !== undefined) process.env.AWS_ACCESS_KEY_ID = savedK;
      delete process.env.AGENTCORE_BIN;
    }
  });
});
