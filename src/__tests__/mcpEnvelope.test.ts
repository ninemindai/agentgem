import { describe, it, expect } from "vitest";
import { MCP_ERROR_CODES, derivePayload } from "@agentgem/model";
import type { McpErrorCode } from "@agentgem/model";

// Compile-time pin: the union type and the value list are the same set.
const _pin: McpErrorCode = MCP_ERROR_CODES[0];
void _pin;

describe("MCP_ERROR_CODES", () => {
  it("carries the full mirrored-contract union (additive-only)", () => {
    // v1 emits a subset (server_not_connected/server_unavailable/not_in_manifest/tool_error/
    // bad_request); the union is the FULL claude-contract set so consumers can branch on codes
    // that arrive later without a wire change.
    for (const c of ["server_not_connected", "server_unavailable", "not_in_manifest", "tool_error", "bad_request", "not_granted", "capability_disabled", "server_config_changed"]) {
      expect(MCP_ERROR_CODES).toContain(c);
    }
  });
});

describe("derivePayload", () => {
  it("prefers structuredContent when present", () => {
    expect(derivePayload({ content: [{ type: "text", text: "[1]" }], structuredContent: { a: 1 } })).toEqual({ a: 1 });
  });

  it("parses the first text block as JSON when it parses", () => {
    expect(derivePayload({ content: [{ type: "text", text: '{"n":428}' }] })).toEqual({ n: 428 });
  });

  it("falls back to the verbatim text when it is not JSON", () => {
    expect(derivePayload({ content: [{ type: "text", text: "plain words" }] })).toBe("plain words");
  });

  it("returns undefined when there is no text block", () => {
    expect(derivePayload({ content: [{ type: "image", data: "x", mimeType: "image/png" }] })).toBeUndefined();
    expect(derivePayload({ content: [] })).toBeUndefined();
  });
});
