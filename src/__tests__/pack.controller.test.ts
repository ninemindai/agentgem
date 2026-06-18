// src/__tests__/pack.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { PackController } from "../pack.controller.js";

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
  app.restController(PackController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(projRoot, { recursive: true, force: true });
});

describe("PackController", () => {
  it("GET /api/inventory returns redacted inventory", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills.map((s: { name: string }) => s.name)).toEqual(["review"]);
    expect(r.body.mcpServers[0].config.env.GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
    expect(r.body.skills[0].source).toBe("standalone");
    expect(r.body.mcpServers[0].source).toBe("user");
  });

  it("POST /api/pack builds a pack from a selection", async () => {
    const r = await client.post("/api/pack")
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

  it("POST /api/pack includes selected artifacts from the keyed project", async () => {
    const r = await client.post("/api/pack")
      .send({ dir, projects: [projRoot], selection: { projects: { [projRoot]: { skills: ["deploy"], includeInstructions: true } } }, name: "p" })
      .expect(200);
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["deploy", "CLAUDE.md"]);
  });

  it("POST /api/pack embeds checks and declares requiredSecrets (names, not values)", async () => {
    const r = await client
      .post("/api/pack")
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
    expect(JSON.parse(r.body.files["pack.json"]).version).toBe("2.0.0");
    expect(r.body.lock.packDigest).toMatch(/^sha256:/);
    expect(r.body.path).toBe(out);
    expect(r.body.files["mcp/gh.json"]).toBeDefined();
    expect(r.body.files["mcp/gh.json"]).toContain("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret"); // redaction survives
    rmSync(out, { recursive: true, force: true });
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
