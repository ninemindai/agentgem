import { describe, it, expect } from "vitest";
import { normalizeAcpError } from "@agentgem/base";

const rpc = (code: number, message = "x", data?: unknown) => Object.assign(new Error(message), { code, data });

describe("normalizeAcpError", () => {
  it("classifies -32603 and -32700 as retryable protocol errors", () => {
    expect(normalizeAcpError(rpc(-32603))).toMatchObject({ kind: "protocol", retryable: true, code: -32603 });
    expect(normalizeAcpError(rpc(-32700))).toMatchObject({ kind: "protocol", retryable: true });
  });
  it("classifies method/param errors as permanent", () => {
    for (const code of [-32601, -32602, -32001, -32002]) {
      expect(normalizeAcpError(rpc(code))).toMatchObject({ kind: "protocol", retryable: false, code });
    }
  });
  it("detects auth-required as permanent auth", () => {
    expect(normalizeAcpError(rpc(-32000, "authentication required"))).toMatchObject({ kind: "auth", retryable: false });
    expect(normalizeAcpError(rpc(-32000, "x", { authRequired: true }))).toMatchObject({ kind: "auth", retryable: false });
  });
  it("auth precedence beats retryable codes: a wrapped login failure is never retryable", () => {
    // Deliberate: adapters wrap upstream errors, so an auth failure can surface as
    // -32603 — retrying it is useless. Pins the auth-before-code-rules ordering.
    expect(normalizeAcpError(rpc(-32603, "authentication required"))).toMatchObject({ kind: "auth", retryable: false, code: -32603 });
  });
  it("classifies process death as a non-retryable crash", () => {
    expect(normalizeAcpError(new Error("agent process exited (code 1, signal null)"))).toMatchObject({ kind: "crash", retryable: false });
    expect(normalizeAcpError(new Error("agent process error: spawn ENOENT"))).toMatchObject({ kind: "crash", retryable: false });
  });
  it("classifies timeouts and unknowns as non-retryable", () => {
    expect(normalizeAcpError(new Error("agent run timed out after 300000ms"))).toMatchObject({ kind: "timeout", retryable: false });
    expect(normalizeAcpError("weird")).toMatchObject({ kind: "unknown", retryable: false });
  });
});
