// packages/console/src/panels/Play/__tests__/mcpIdentity.test.ts
import { describe, it, expect } from "vitest";
import { mcpIdentity, McpIdentityError } from "../mcpIdentity.js";

describe("mcpIdentity", () => {
  it("coalesces key-order-different but logically-identical inputs", () => {
    expect(mcpIdentity("gh", "list", { a: 1, b: 2 }).key).toBe(mcpIdentity("gh", "list", { b: 2, a: 1 }).key);
  });
  it("normalizes nested objects recursively (sorted keys), and body is the normalized value", () => {
    const r = mcpIdentity("gh", "list", { z: { y: 1, x: 2 }, a: [3, { d: 4, c: 5 }] });
    expect(r.key).toContain('"a":[3,{"c":5,"d":4}]');       // arrays keep order; object keys sorted
    // body is the normalized value the poll will send to /call — its serialization is stable/sorted
    expect(JSON.stringify(r.body)).toBe('{"a":[3,{"c":5,"d":4}],"z":{"x":2,"y":1}}');
  });
  it("distinguishes different servers/tools/inputs", () => {
    expect(mcpIdentity("gh", "list", {}).key).not.toBe(mcpIdentity("gh", "get", {}).key);
    expect(mcpIdentity("gh", "list", {}).key).not.toBe(mcpIdentity("sl", "list", {}).key);
    expect(mcpIdentity("gh", "list", { a: 1 }).key).not.toBe(mcpIdentity("gh", "list", { a: 2 }).key);
  });
  it("treats undefined/absent input as the same empty call", () => {
    expect(mcpIdentity("gh", "list").key).toBe(mcpIdentity("gh", "list", undefined).key);
  });
  it("does not collide across (server, tool) pairs that straddle the old delimiters", () => {
    expect(mcpIdentity("s", "1|tool:2").key).not.toBe(mcpIdentity("s|tool:1", "2").key);
    expect(mcpIdentity("server:gh", "list").key).not.toBe(mcpIdentity("server", "gh|tool:list").key);
    expect(mcpIdentity("a", "b|tool:c").key).not.toBe(mcpIdentity("a|tool:b", "c").key);
  });
  it("REJECTS unsupported values with McpIdentityError", () => {
    for (const bad of [{ d: new Date() }, { n: NaN }, { i: Infinity }, { f: () => 1 }, { b: 10n }] as unknown[]) {
      expect(() => mcpIdentity("gh", "list", bad)).toThrow(McpIdentityError);
    }
  });
});
