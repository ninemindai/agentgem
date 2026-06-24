import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { startEmbeddedServer } from "../server.js";

// __dirname at runtime is desktop/src/__tests__ under vitest; the core resolver
// expects the compiled main dir (desktop/dist). The dev candidate walks two
// levels up from there to repo dist, so pass a path two levels below repo root.
const fakeMainDir = join(__dirname, "..", "..", "dist");

describe("startEmbeddedServer", () => {
  it("starts the core and serves the UI, then stops cleanly", async () => {
    const srv = await startEmbeddedServer(fakeMainDir, "/nonexistent-resources");
    try {
      expect(srv.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${srv.url}/`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body.toLowerCase()).toContain("<!doctype html");
    } finally {
      await srv.stop();
    }
  });
});
