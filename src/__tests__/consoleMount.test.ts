import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../index.js";

describe("UI routing (console cutover)", () => {
  it("serves the React console at / and /console", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    for (const path of ["/", "/console"]) {
      const res = await request(server.expressApp).get(path).set("Host", "127.0.0.1");
      expect(res.status).toBe(200);
      expect(res.type).toMatch(/html/);
      expect(res.text).toContain('<div id="root"></div>');
    }
  });

  it("preserves the vanilla UI at /legacy", async () => {
    const app = await createApp(0);
    const server = await app.restServer;
    const res = await request(server.expressApp).get("/legacy").set("Host", "127.0.0.1");
    expect(res.status).toBe(200);
    expect(res.type).toMatch(/html/);
    expect(res.text).toContain("Lapidary Ledger");
  });
});
