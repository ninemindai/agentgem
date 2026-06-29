import { describe, it, expect, afterEach } from "vitest";
import { postShare, DEFAULT_AGGREGATOR_URL } from "../shareClient.js";

const counts = { breadth: 1, battleTested: 1, portable: 1 };
afterEach(() => { delete process.env.AGENTGEM_AGGREGATOR_URL; });

describe("postShare", () => {
  it("POSTs to the configured endpoint and returns id/url", async () => {
    let seen: { url: string; body: string } | null = null;
    const http = async (url: string, init: { body: string }) => { seen = { url, body: init.body }; return { status: 200, json: async () => ({ id: "x10", url: "https://agentgem.ai/share/x10" }) }; };
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http });
    expect(r).toEqual({ id: "x10", url: "https://agentgem.ai/share/x10" });
    expect(seen!.url).toBe("https://api.test/api/aggregator/share");
    expect(JSON.parse(seen!.body)).toEqual({ kind: "certificate", counts, generatedAtMs: 9 });
  });

  it("defaults to the hosted aggregator (app.agentgem.ai) when nothing is configured", async () => {
    let seenUrl = "";
    const http = async (url: string) => { seenUrl = url; return { status: 200, json: async () => ({ id: "a", url: "u" }) }; };
    await postShare({ counts, generatedAtMs: 9, http });
    expect(seenUrl).toBe(`${DEFAULT_AGGREGATOR_URL}/api/aggregator/share`);
    expect(DEFAULT_AGGREGATOR_URL).toBe("https://app.agentgem.ai");
  });

  it("AGENTGEM_AGGREGATOR_URL overrides the default", async () => {
    process.env.AGENTGEM_AGGREGATOR_URL = "https://staging.example";
    let seenUrl = "";
    const http = async (url: string) => { seenUrl = url; return { status: 200, json: async () => ({ id: "a", url: "u" }) }; };
    await postShare({ counts, generatedAtMs: 9, http });
    expect(seenUrl).toBe("https://staging.example/api/aggregator/share");
  });

  it("an explicit empty endpoint disables sharing (skips)", async () => {
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "" });
    expect(r).toEqual({ skipped: true });
  });

  it("throws on a non-2xx", async () => {
    const http = async () => ({ status: 500, json: async () => ({}) });
    await expect(postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http })).rejects.toThrow(/share 500/);
  });
});
