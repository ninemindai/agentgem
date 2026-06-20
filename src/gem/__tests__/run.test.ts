// src/gem/__tests__/run.test.ts
import { describe, it, expect } from "vitest";
import { pushLog, nodeMajor, parseEveUrl, parseVercelUrl } from "../run.js";

describe("run pure helpers", () => {
  it("pushLog caps the buffer at 200 lines (drops oldest)", () => {
    const buf: string[] = [];
    for (let i = 0; i < 250; i++) pushLog(buf, `line ${i}`);
    expect(buf.length).toBe(200);
    expect(buf[0]).toBe("line 50");
    expect(buf[199]).toBe("line 249");
  });

  it("nodeMajor parses the major version", () => {
    expect(nodeMajor("v24.13.0")).toBe(24);
    expect(nodeMajor("18.0.0")).toBe(18);
    expect(nodeMajor("garbage")).toBe(0);
  });

  it("parseEveUrl returns the first http(s) URL in the lines", () => {
    expect(parseEveUrl(["starting…", "Listening on http://127.0.0.1:3000"])).toBe("http://127.0.0.1:3000");
    expect(parseEveUrl(["no url here"])).toBeUndefined();
  });

  it("parseVercelUrl returns the deployment .vercel.app URL", () => {
    expect(parseVercelUrl(["Inspect: x", "https://gem-abc123.vercel.app"])).toBe("https://gem-abc123.vercel.app");
    expect(parseVercelUrl(["http://localhost:3000"])).toBeUndefined();
  });
});
