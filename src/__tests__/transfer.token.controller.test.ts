// src/__tests__/transfer.token.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { createAccount } from "@nats-io/nkeys";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let prevSeed: string | undefined;
let prevWs: string | undefined;

beforeAll(async () => {
  prevSeed = process.env.NATS_ACCOUNT_SEED;
  prevWs = process.env.NATS_WS_URL;
  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  if (prevSeed !== undefined) process.env.NATS_ACCOUNT_SEED = prevSeed; else delete process.env.NATS_ACCOUNT_SEED;
  if (prevWs !== undefined) process.env.NATS_WS_URL = prevWs; else delete process.env.NATS_WS_URL;
});

describe("POST /api/transfer/token", () => {
  it("returns 400 with an actionable message when unconfigured", async () => {
    delete process.env.NATS_ACCOUNT_SEED;
    delete process.env.NATS_WS_URL;
    const r = await client.post("/api/transfer/token").send({ scope: "receive" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not configured/);
  });

  it("returns minted creds + wsUrl + expiresAt when configured", async () => {
    process.env.NATS_ACCOUNT_SEED = new TextDecoder().decode(createAccount().getSeed());
    process.env.NATS_WS_URL = "wss://broker.example:443";
    const r = await client.post("/api/transfer/token").send({ scope: "receive" }).expect(200);
    expect(r.body.creds).toContain("NATS USER JWT");
    expect(r.body.wsUrl).toBe("wss://broker.example:443");
    expect(typeof r.body.expiresAt).toBe("number");
  });
});
