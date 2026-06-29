import { describe, it, expect } from "vitest";
import { postShare } from "../shareClient.js";

const counts = { breadth: 1, battleTested: 1, portable: 1 };

describe("postShare", () => {
  it("POSTs to the configured endpoint and returns id/url", async () => {
    let seen: { url: string; body: string } | null = null;
    const http = async (url: string, init: { body: string }) => { seen = { url, body: init.body }; return { status: 200, json: async () => ({ id: "x10", url: "https://agentgem.ai/share/x10" }) }; };
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http });
    expect(r).toEqual({ id: "x10", url: "https://agentgem.ai/share/x10" });
    expect(seen!.url).toBe("https://api.test/api/aggregator/share");
    expect(JSON.parse(seen!.body)).toEqual({ kind: "certificate", counts, generatedAtMs: 9 });
  });

  it("skips when no endpoint and no local port are available", async () => {
    const r = await postShare({ counts, generatedAtMs: 9, endpoint: "" });
    expect(r).toEqual({ skipped: true });
  });

  it("throws on a non-2xx", async () => {
    const http = async () => ({ status: 500, json: async () => ({}) });
    await expect(postShare({ counts, generatedAtMs: 9, endpoint: "https://api.test", http })).rejects.toThrow(/share 500/);
  });
});
