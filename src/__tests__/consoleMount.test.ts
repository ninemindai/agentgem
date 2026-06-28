import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("GET /console", () => {
  it("serves the console SPA as html, same-origin", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/console").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain('<div id="root"></div>');
  });
});
