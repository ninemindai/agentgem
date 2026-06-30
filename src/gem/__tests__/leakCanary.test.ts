// src/gem/__tests__/leakCanary.test.ts
import { describe, it, expect } from "vitest";
import { scanGemForLeaks, assertGemSafe, GemLeakError } from "@agentgem/base";
import { findStrongCredentials, redactStrongCredentials } from "@agentgem/base";
import type { Gem } from "@agentgem/model";

// Minimal Gem builder — only the fields the canary scans matter here.
function gem(parts: Partial<Gem>): Gem {
  return { name: "g", createdFrom: "test", artifacts: [], checks: [], requiredSecrets: [], ...parts } as Gem;
}
function mcp(name: string, config: Record<string, unknown>): Gem["artifacts"][number] {
  return { type: "mcp_server", name, transport: "stdio", config } as Gem["artifacts"][number];
}

describe("findStrongCredentials", () => {
  it("flags JWT / provider token / PEM / URL credential, masked", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const hits = findStrongCredentials(`${jwt} ghp_abcd1234efgh5678 postgres://u:Hunter2@h/d`);
    expect(hits.map((h) => h.kind).sort()).toEqual(["jwt", "provider-token", "url-credential"]);
    // masked: prefix + length only, never the raw secret
    expect(JSON.stringify(hits)).not.toContain("Hunter2");
    expect(JSON.stringify(hits)).not.toContain("dozjgNry");
    expect(hits.find((h) => h.kind === "jwt")?.sample).toMatch(/^eyJh…\(\d+ chars\)$/);
  });

  it("does not flag an already-redacted DSN or a credential-free URL", () => {
    expect(findStrongCredentials("postgres://u:<redacted>@host/db")).toEqual([]);
    expect(findStrongCredentials("https://mcp.example.com/sse")).toEqual([]);
  });

  it("redactStrongCredentials output is clean under the scanner (round-trip)", () => {
    const dirty = "tok eyJaaaaaa.bbbb.cccc and ghp_abcd1234efgh5678 and db://u:p@h";
    expect(findStrongCredentials(redactStrongCredentials(dirty))).toEqual([]);
  });
});

describe("scanGemForLeaks", () => {
  it("passes a clean gem (redacted artifacts)", () => {
    const g = gem({ artifacts: [mcp("ctx", { env: { OPENAI_API_KEY: "<redacted>" }, url: "https://ok/sse" })] });
    expect(scanGemForLeaks(g)).toEqual({ ok: true, findings: [] });
  });

  it("catches a raw secret that survived redaction, attributing it to its artifact", () => {
    const g = gem({
      artifacts: [
        mcp("ctx", { env: { OPENAI_API_KEY: "<redacted>" } }), // clean
        mcp("leaky", { headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.dozjgNryP4J3jVmNHl0w5N" } }),
      ],
    });
    const r = scanGemForLeaks(g);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ kind: "jwt", artifact: "leaky" });
    expect(JSON.stringify(r)).not.toContain("dozjgNry"); // report stays masked
  });

  it("scans top-level fields under <gem> (e.g. a secret smuggled into a check)", () => {
    const g = gem({ checks: [{ name: "c", kind: "behavioral", setup: { note: "ghp_abcd1234efgh5678" } }] as never });
    const r = scanGemForLeaks(g);
    expect(r.ok).toBe(false);
    expect(r.findings[0]).toMatchObject({ kind: "provider-token", artifact: "<gem>" });
  });
});

describe("assertGemSafe (fail-closed gate)", () => {
  it("returns silently for a clean gem", () => {
    expect(() => assertGemSafe(gem({ artifacts: [mcp("ok", { url: "https://ok/sse" })] }))).not.toThrow();
  });

  it("throws GemLeakError with masked findings for a leaky gem", () => {
    const g = gem({ artifacts: [mcp("leaky", { token: "ghp_abcd1234efgh5678" })] });
    try {
      assertGemSafe(g);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GemLeakError);
      const err = e as GemLeakError;
      expect(err.findings[0]).toMatchObject({ kind: "provider-token", artifact: "leaky" });
      expect(err.message).toContain("Refusing to release Gem");
      expect(err.message).not.toContain("ghp_abcd1234efgh5678"); // never the raw value
    }
  });
});
