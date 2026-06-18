// src/pack/__tests__/mcpProxy.test.ts
import { describe, it, expect } from "vitest";
import { stdioProxyRunner, PROXY_BASE_PORT } from "../mcpProxy.js";

describe("stdioProxyRunner", () => {
  it("generates a runnable stdio->HTTP bridge with the command, port, and SDK imports", () => {
    const src = stdioProxyRunner("local", "npx", ["-y", "some-mcp"], ["DB_TOKEN"], PROXY_BASE_PORT);
    expect(src).toContain("StdioClientTransport");
    expect(src).toContain("StreamableHTTPServerTransport");
    expect(src).toContain('command: "npx"');
    expect(src).toContain('["-y","some-mcp"]');
    expect(src).toContain(`app.listen(${PROXY_BASE_PORT}`);
    // env passthrough, not embedded secrets — the secret name is listed for the operator
    expect(src).toContain("env: process.env");
    expect(src).toContain("DB_TOKEN");
  });

  it("omits the secret note when the server needs no secrets", () => {
    const src = stdioProxyRunner("plain", "node", ["server.js"], [], 7801);
    expect(src).not.toContain("Set these env vars");
    expect(src).toContain('command: "node"');
  });
});
