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

  it("GET /api/inventory?project= returns a redacted project section", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}&project=${encodeURIComponent(projRoot)}`).expect(200);
    expect(r.body.project.root).toBe(projRoot);
    expect(r.body.project.skills.map((s: { name: string }) => s.name)).toEqual(["deploy"]);
    expect(r.body.project.skills[0].source).toBe("project");
    expect(r.body.project.mcpServers[0].config.env.PW).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("projsecret");
  });

  it("POST /api/pack includes selected project artifacts", async () => {
    const r = await client.post("/api/pack")
      .send({ dir, project: projRoot, selection: { projectSkills: ["deploy"], includeProjectInstructions: true }, name: "p" })
      .expect(200);
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["deploy", "CLAUDE.md"]);
  });
});
