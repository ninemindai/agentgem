import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encodeTicket, parseTicket } from "@agentgem/transfer";

describe("ticket", () => {
  it("round-trips bucket/object/key", () => {
    const key = randomBytes(32);
    const back = parseTicket(encodeTicket({ bucket: "transfer", object: "ab12", key }));
    expect(back.bucket).toBe("transfer");
    expect(back.object).toBe("ab12");
    expect(back.key).toEqual(key);
  });
  it("keeps the key only in the fragment", () => {
    const key = randomBytes(32);
    const s = encodeTicket({ bucket: "b", object: "o", key });
    const beforeHash = s.split("#")[0];
    expect(beforeHash).not.toContain(key.toString("base64url"));
  });
  it("rejects a non-agentgem ticket", () => {
    expect(() => parseTicket("https://evil/x")).toThrow();
  });
  it("rejects a wrong-length key", () => {
    const badKey = Buffer.alloc(8).toString("base64url");
    expect(() => parseTicket(`agentgem://gem/b/o#${badKey}`)).toThrow(/32 bytes/);
  });
  it("round-trips an optional producer in the fragment", () => {
    const key = randomBytes(32);
    const producer = { publicKey: "ed25519-pub", signature: "sigB64", account: "alice" };
    const back = parseTicket(encodeTicket({ bucket: "b", object: "o", key, producer }));
    expect(back.producer).toEqual(producer);
    expect(back.key).toEqual(key);
  });
  it("parses a legacy ticket with no producer (no ~) as unsigned", () => {
    const key = randomBytes(32);
    const legacy = encodeTicket({ bucket: "b", object: "o", key });
    expect(legacy).not.toContain("~");
    expect(parseTicket(legacy).producer).toBeUndefined();
  });
  it("treats a malformed producer segment as unsigned (does not throw)", () => {
    const key = randomBytes(32).toString("base64url");
    const t = `agentgem://gem/b/o#${key}~not-valid-base64-json`;
    expect(parseTicket(t).producer).toBeUndefined();
  });
});
