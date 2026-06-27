// src/__tests__/transfer.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { exportGem } from "../gem/share.js";
import type { Gem } from "../gem/types.js";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let prevNatsUrl: string | undefined;

const demoGem: Gem = {
  name: "github-search",
  createdFrom: "/tmp/.claude",
  checks: [],
  requiredSecrets: [],
  artifacts: [{ type: "skill", name: "search", source: "standalone", content: "# Search\nFind things.\n" }],
};

beforeAll(async () => {
  prevNatsUrl = process.env.NATS_URL;
  delete process.env.NATS_URL; // transfer endpoints must report "not configured" without a broker
  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  if (prevNatsUrl !== undefined) process.env.NATS_URL = prevNatsUrl;
});

describe("POST /api/materialize (bytesBase64 source)", () => {
  it("materializes a gem from in-memory bytes (the receive-then-install path)", async () => {
    const bytesBase64 = exportGem(demoGem, { version: "1.0.0" }).bytes.toString("base64");
    const r = await client.post("/api/materialize").send({ bytesBase64, target: "codex" }).expect(200);
    expect(r.body.target).toBe("codex");
    // the skill body must never carry through as a secret-bearing literal; just assert it rendered something
    expect(JSON.stringify(r.body)).toContain("search");
  });
});

describe("POST /api/transfer/* (NATS unconfigured)", () => {
  it("transfer/receive fails clearly when NATS is not configured", async () => {
    const ticket = "agentgem://gem/b/o#" + Buffer.alloc(32).toString("base64url");
    const r = await client.post("/api/transfer/receive").send({ ticket });
    expect(r.status >= 400 || (r.body && r.body.error)).toBeTruthy();
  });
});
