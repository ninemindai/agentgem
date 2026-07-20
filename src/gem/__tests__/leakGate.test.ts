// src/gem/__tests__/leakGate.test.ts
//
// The leak canary is unit-tested in leakCanary.test.ts, but a gate nobody calls protects nothing.
// These tests pin the WIRING: every path that sends a Gem off the machine must fail closed.
// SECURITY.md's headline promise ("secrets never leave your device") is only true if these pass.
import { describe, it, expect } from "vitest";
import { GemLeakError } from "@agentgem/base";
import { exportGem } from "@agentgem/distribute";
import type { Gem } from "@agentgem/model";

// A real-shaped provider token: matches the strong-credential net, so redaction should have caught
// it upstream. If it reaches an egress path, that path is the bug.
const LEAKED_TOKEN = "ghp_abcd1234efgh5678";

function gem(parts: Partial<Gem>): Gem {
  return { name: "g", createdFrom: "test", artifacts: [], checks: [], requiredSecrets: [], ...parts } as Gem;
}
function mcp(name: string, config: Record<string, unknown>): Gem["artifacts"][number] {
  return { type: "mcp_server", name, transport: "stdio", config } as Gem["artifacts"][number];
}

const clean = gem({ artifacts: [mcp("ok", { url: "https://ok.example.com/sse" })] });
const dirty = gem({ artifacts: [mcp("leaky", { env: { GITHUB_TOKEN: LEAKED_TOKEN } })] });

describe("egress gate: exportGem (share · transfer · download · hosted publish)", () => {
  it("refuses to serialize a Gem carrying a surviving credential", () => {
    expect(() => exportGem(dirty)).toThrow(GemLeakError);
  });

  it("never puts the raw secret in the thrown error", () => {
    try {
      exportGem(dirty);
      expect.unreachable("exportGem should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GemLeakError);
      expect(String(e)).not.toContain(LEAKED_TOKEN);
      expect((e as GemLeakError).findings[0]).toMatchObject({ kind: "provider-token", artifact: "leaky" });
    }
  });

  it("passes a clean Gem through unchanged", () => {
    const out = exportGem(clean, { version: "1.2.3" });
    expect(out.filename).toBe("g-1.2.3.gem");
    expect(out.bytes.length).toBeGreaterThan(0);
  });
});

