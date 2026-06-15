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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ap-"));
  mkdirSync(join(dir, "skills", "review"), { recursive: true });
  writeFileSync(join(dir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n# Review\n");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ mcpServers: { gh: { command: "npx", env: { GH_TOKEN: "ghp_secret" } } } }));
  writeFileSync(join(dir, "CLAUDE.md"), "global instructions");

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
});

describe("PackController", () => {
  it("GET /api/inventory returns redacted inventory", async () => {
    const r = await client.get(`/api/inventory?dir=${encodeURIComponent(dir)}`).expect(200);
    expect(r.body.skills.map((s: { name: string }) => s.name)).toEqual(["review"]);
    expect(r.body.mcpServers[0].config.env.GH_TOKEN).toBe("<redacted>");
    expect(JSON.stringify(r.body)).not.toContain("ghp_secret");
  });

  it("POST /api/pack builds a pack from a selection", async () => {
    const r = await client.post("/api/pack")
      .send({ dir, selection: { skills: ["review"], includeInstructions: true }, name: "demo" })
      .expect(200);
    expect(r.body.name).toBe("demo");
    expect(r.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["review", "CLAUDE.md"]);
  });
});
