import { describe, it, expect, afterEach } from "vitest";
import { serverHost } from "../index.js";

const orig = process.env.HOST;
afterEach(() => { if (orig === undefined) delete process.env.HOST; else process.env.HOST = orig; });

describe("serverHost", () => {
  it("defaults to loopback (127.0.0.1) when HOST is unset — local stays loopback-only", () => {
    delete process.env.HOST;
    expect(serverHost()).toBe("127.0.0.1");
  });
  it("honors HOST so a deploy can bind 0.0.0.0", () => {
    process.env.HOST = "0.0.0.0";
    expect(serverHost()).toBe("0.0.0.0");
  });
});
