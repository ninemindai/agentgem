import { describe, it, expect } from "vitest";
import { stdioMcpServer } from "@agentgem/base";

describe("stdioMcpServer", () => {
  it("builds an McpServerStdio with env as name/value pairs", () => {
    expect(stdioMcpServer("goldmine", "/usr/bin/node", ["srv.js"], { ROOT: "/p" })).toEqual({
      name: "goldmine", command: "/usr/bin/node", args: ["srv.js"], env: [{ name: "ROOT", value: "/p" }],
    });
  });
  it("defaults env to empty array", () => {
    expect(stdioMcpServer("x", "node", []).env).toEqual([]);
  });
});
