// src/distill/__tests__/tools.test.ts
import { describe, it, expect } from "vitest";
import { inspectIngredientsTool, buildAttestationTool, dispatchTool } from "../mcpServer.js";

const inventory = { skills: [{ type: "skill" as const, name: "qa", source: "@acme/qa", content: "B" }],
  mcpServers: [{ type: "mcp_server" as const, name: "gh", transport: "stdio" as const, config: { command: "npx", args: ["@modelcontextprotocol/server-github"] } }],
  instructions: [], hooks: [] };
const signal = { root: "/p", flavor: "claude" as const, sessions: { scanned: 1, firstMs: 0, lastMs: 0, spanDays: 0 },
  artifacts: [{ type: "mcp_server" as const, name: "gh", root: null, invocations: 3, sessionsUsedIn: 1, lastUsedMs: 0, confidence: "high" as const }],
  unresolved: [], coOccurrence: [], shapes: [], notes: [], models: [{ id: "claude-opus-4-8", sessions: 1 }] };

describe("distill tools", () => {
  it("inspect_ingredients returns canonical ids", () => {
    const r = inspectIngredientsTool({ inventory, signal });
    expect(r.mcps[0].id).toBe("npx:@modelcontextprotocol/server-github");
    expect(r.models).toEqual(["claude-opus-4-8"]);
  });
  it("build_attestation returns an unsigned, aggregate-only envelope + preview", () => {
    const r = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["gh"] }, salt: "S" });
    expect(r.attestation.signature).toBe("");
    expect(r.willPublish.includes("npx:@modelcontextprotocol/server-github")).toBe(true);
    // aggregate-only evidence: no synthetic per-session tuples
    expect((r.attestation.evidence as unknown as Record<string, unknown>).tuples).toBeUndefined();
    expect(r.attestation.ingredients.mcps[0].invocations).toBe(3);
  });
  it("dispatchTool routes scan_workflow through injected deps", async () => {
    const deps = { loadContext: () => ({ inventory, signal }), salt: "S" };
    const r = (await dispatchTool("scan_workflow", { cwd: "/p" }, deps)) as { signalDigest: string };
    expect(r.signalDigest.startsWith("sha256:")).toBe(true);
    const ins = (await dispatchTool("inspect_ingredients", {}, deps)) as { models: string[] };
    expect(ins.models).toEqual(["claude-opus-4-8"]);
    await expect(dispatchTool("nope", {}, deps)).rejects.toThrow("unknown tool nope");
  });
  it("sign_and_publish rejects a missing selection (privacy-gate, no bypass to all)", async () => {
    const deps = { loadContext: () => ({ inventory, signal }), salt: "S" };
    await expect(dispatchTool("sign_and_publish", {}, deps)).rejects.toThrow("requires an explicit selection");
  });
  it("sign_and_publish IGNORES caller-authored counts and signs the real scan-derived counts", async () => {
    let publishedAttestation: { ingredients: { mcps: { id: string; invocations: number }[] } } | undefined;
    const deps = {
      loadContext: () => ({ inventory, signal }),
      salt: "S",
      publish: async (_gem: unknown, files: Record<string, string>) => {
        publishedAttestation = JSON.parse(files["attestation.json"]);
        return { ref: "test-ref" };
      },
    };
    // A malicious host agent inflates invocations to 999 and adds a bogus field.
    const tampered = { ingredients: { mcps: [{ id: "npx:@modelcontextprotocol/server-github", invocations: 999 }] }, bogus: "evil" };
    await dispatchTool("sign_and_publish", { selection: { mcpServers: ["gh"] }, attestation: tampered }, deps);

    expect(publishedAttestation).toBeDefined();
    const mcp = publishedAttestation!.ingredients.mcps.find((m) => m.id === "npx:@modelcontextprotocol/server-github")!;
    expect(mcp.invocations).toBe(3); // REAL scan count, NOT the tampered 999
    // The published attestation equals a fresh server-side rebuild (modulo signing fields), proving args.attestation was discarded.
    const fresh = buildAttestationTool({ inventory, signal, selection: { mcpServers: ["gh"] }, salt: "S" });
    expect(publishedAttestation!.ingredients).toEqual(fresh.attestation.ingredients);
    expect(JSON.stringify(publishedAttestation)).not.toContain("evil");
  });
});
