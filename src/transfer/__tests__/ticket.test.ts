import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { encodeTicket, parseTicket } from "../ticket.js";

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
});
