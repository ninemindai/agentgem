// src/__tests__/transfer.ciphertext.controller.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import supertest from "supertest";
import { RestApplication } from "@agentback/rest";
import { GemController } from "../gem.controller.js";
import { InMemoryObjectStore } from "@agentgem/transfer";
import { setStoreFactoryForTests } from "@agentgem/transfer";

let app: RestApplication;
let client: ReturnType<typeof supertest>;
let prevUrl: string | undefined;

beforeAll(async () => {
  prevUrl = process.env.NATS_URL;
  app = new RestApplication({});
  app.configure("servers.RestServer").to({ port: 0, host: "127.0.0.1" });
  app.restController(GemController);
  await app.start();
  const server = await app.restServer;
  client = supertest(server.url);
});
afterAll(async () => {
  await app.stop();
  setStoreFactoryForTests(undefined);
  if (prevUrl !== undefined) process.env.NATS_URL = prevUrl; else delete process.env.NATS_URL;
});

describe("POST /api/transfer/ciphertext", () => {
  it("returns the stored ciphertext (base64) and burns the object", async () => {
    const store = new InMemoryObjectStore();
    const object = await store.put(Buffer.from("CIPHERTEXT-BYTES"));
    setStoreFactoryForTests(async () => store);

    const r = await client.post("/api/transfer/ciphertext").send({ object }).expect(200);
    expect(Buffer.from(r.body.ciphertextBase64, "base64").toString()).toBe("CIPHERTEXT-BYTES");

    // burned: a second fetch must fail
    const r2 = await client.post("/api/transfer/ciphertext").send({ object });
    expect(r2.status).not.toBe(200);
  });

  it("returns 400 when NATS is not configured", async () => {
    setStoreFactoryForTests(undefined);
    delete process.env.NATS_URL;
    const r = await client.post("/api/transfer/ciphertext").send({ object: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not configured/);
  });
});
