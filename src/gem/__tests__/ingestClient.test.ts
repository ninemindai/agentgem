import { describe, it, expect } from "vitest";
import { postAttestation } from "../ingestClient.js";

const att = { formatVersion: 1 } as never;

describe("postAttestation", () => {
  it("skips when no endpoint configured", async () => {
    expect(await postAttestation({ attestation: att, endpoint: "" })).toEqual({ skipped: true });
  });
  it("POSTs and returns ingestId on 200", async () => {
    let seen = "";
    const http = async (_url: string, init: { body: string; headers: Record<string,string> }) => {
      seen = init.headers.Authorization;
      return { status: 200, json: async () => ({ ingestId: "ing_1" }) };
    };
    const r = await postAttestation({ attestation: att, endpoint: "https://x/ingest", token: "T", http });
    expect(r).toEqual({ ingestId: "ing_1" });
    expect(seen).toBe("Bearer T");
  });
  it("throws on non-2xx", async () => {
    const http = async () => ({ status: 422, json: async () => ({}) });
    await expect(postAttestation({ attestation: att, endpoint: "https://x/ingest", token: "T", http })).rejects.toThrow("ingest 422");
  });
  it("throws when 200 response is missing ingestId", async () => {
    const http = async () => ({ status: 200, json: async () => ({}) });
    await expect(postAttestation({ attestation: att, endpoint: "https://x/ingest", token: "T", http })).rejects.toThrow(/missing ingestId/);
  });
});
