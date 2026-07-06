// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";
import { executableArtifacts, hasExecutable, fetchHostedArchive } from "../hostedInstall.js";
import { sampleGem } from "../../aggregator/__tests__/helpers/publishFixtures.js";

describe("executableArtifacts", () => {
  it("lists mcp servers and hooks (not skills/instructions)", () => {
    expect(executableArtifacts(sampleGem())).toEqual({ mcp: ["gh"], hooks: ["fmt"] });
    expect(hasExecutable(sampleGem())).toBe(true);
  });
  it("is empty for a text-only gem", () => {
    const g = { name: "x", createdFrom: "/x", checks: [], requiredSecrets: [], artifacts: [{ type: "skill", name: "s", source: "standalone", content: "" } as const] };
    expect(executableArtifacts(g)).toEqual({ mcp: [], hooks: [] });
    expect(hasExecutable(g)).toBe(false);
  });
});

describe("fetchHostedArchive", () => {
  it("downloads and base64-decodes the archive", async () => {
    const http = vi.fn(async (_url: string) => ({ status: 200, json: async () => ({ archiveBase64: Buffer.from([1, 2, 3]).toString("base64") }) }));
    const bytes = await fetchHostedArchive({ key: "@o/setup", version: "1.0.0", endpoint: "https://api.agentgem.ai", http });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(http.mock.calls[0][0]).toBe("https://api.agentgem.ai/api/aggregator/gem-archive?key=%40o%2Fsetup&version=1.0.0");
  });
  it("throws a friendly 400 for a missing gem (404)", async () => {
    const http = vi.fn(async () => ({ status: 404, json: async () => ({}) }));
    await expect(fetchHostedArchive({ key: "@o/none", version: "1.0.0", endpoint: "https://api.agentgem.ai", http })).rejects.toMatchObject({ statusCode: 400 });
  });
});
