import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("PWA manifest route", () => {
  it("serves /manifest.webmanifest as an installable manifest", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/manifest.webmanifest").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/manifest\+json/);
    expect(res.body.display).toBe("standalone");
    expect(res.body.icons.length).toBeGreaterThanOrEqual(2);
  });
});
