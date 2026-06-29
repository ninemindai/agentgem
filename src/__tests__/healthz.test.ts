import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("health endpoint", () => {
  // Orchestrators (Cloud Run / ECS / Fly / k8s) probe an unauthenticated liveness URL.
  // No Host/Origin set here on purpose: a probe is origin-less and must still pass.
  it("GET /healthz returns 200 {status:'ok'}", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
