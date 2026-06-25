// src/gem/__tests__/safeFetch.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { isBlockedAddress, assertPublicUrl, fetchGemBytes } from "../safeFetch.js";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, and metadata ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
                       "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "fd12::1",
                       "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/i);
    await expect(assertPublicUrl("ftp://example.com/x")).rejects.toThrow(/http/i);
  });
  it("rejects a URL whose host resolves to a private/loopback address", async () => {
    await expect(assertPublicUrl("http://127.0.0.1:8080/x.gem")).rejects.toThrow(/non-public|private|address/i);
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public|private|address/i);
  });
  it("rejects a malformed URL", async () => {
    await expect(assertPublicUrl("not a url")).rejects.toThrow(/invalid/i);
  });
});

describe("fetchGemBytes", () => {
  let server: Server | undefined;
  afterEach(async () => { if (server) await new Promise<void>((r) => server!.close(() => r())); server = undefined; });

  it("blocks a loopback URL by default (SSRF guard)", async () => {
    await expect(fetchGemBytes("http://127.0.0.1:1/x.gem")).rejects.toThrow(/non-public|private|address/i);
  });

  it("fetches bytes when private access is explicitly allowed (test/escape hatch)", async () => {
    const payload = Buffer.from("GEMBYTES");
    server = createServer((_q, res) => { res.writeHead(200); res.end(payload); });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const port = (server!.address() as { port: number }).port;
    const got = await fetchGemBytes(`http://127.0.0.1:${port}/x.gem`, { allowPrivate: true });
    expect(got.equals(payload)).toBe(true);
  });
});
