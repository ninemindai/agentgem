// src/__tests__/nostrLinkLocal.test.ts
import { describe, it, expect } from "vitest";
import { linkLocalNostr } from "../nostr/linkLocal.js";
import { nostrIdentityFromSecret, verifyNostrEvent, type NostrEvent } from "@agentgem/model";

const SK = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";
const session = { sessionToken: "tok-abc" };
const identity = nostrIdentityFromSecret(SK);

interface FakeRes { ok: boolean; status?: number; body?: unknown }
function fakeFetch(responses: FakeRes[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: URL | string, init: RequestInit) => {
    calls.push({ url: url.toString(), init });
    const r = responses.shift()!;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body ?? {} } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const opts = { base: "https://api.test", session, identity };

describe("linkLocalNostr (local fast-path)", () => {
  it("issues a challenge, signs it locally, links, and returns the npub", async () => {
    const { impl, calls } = fakeFetch([
      { ok: true, body: { challenge: "chal-xyz" } },
      { ok: true, body: { npub: NPUB, connected: ["github", "nostr"] } },
    ]);
    const r = await linkLocalNostr({ ...opts, fetchImpl: impl, now: () => 1_700_000_000_000 });
    expect(r).toEqual({ ok: true, npub: NPUB, connected: ["github", "nostr"] });

    // challenge: POST with the session bearer
    expect(calls[0].url).toBe("https://api.test/api/account/nostr/challenge");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok-abc");

    // link: a locally-signed event carrying the challenge tag, verifiable and from our key
    const sent = JSON.parse(calls[1].init.body as string).event as NostrEvent;
    expect(sent.tags).toContainEqual(["challenge", "chal-xyz"]);
    expect(sent.pubkey).toBe(identity.pubkeyHex);
    expect(sent.created_at).toBe(1_700_000_000); // unix seconds, not ms
    expect(verifyNostrEvent(sent)).toBe(true);
  });

  it("reports signed-out when there is no bind session", async () => {
    const { impl } = fakeFetch([]);
    expect(await linkLocalNostr({ ...opts, session: null, fetchImpl: impl })).toEqual({ ok: false, reason: "signed-out" });
  });

  it("reports challenge-failed on a non-2xx challenge", async () => {
    const { impl } = fakeFetch([{ ok: false, status: 401 }]);
    expect(await linkLocalNostr({ ...opts, fetchImpl: impl })).toEqual({ ok: false, reason: "challenge-failed", detail: "HTTP 401" });
  });

  it("surfaces the server's error message on link failure", async () => {
    const { impl } = fakeFetch([
      { ok: true, body: { challenge: "c" } },
      { ok: false, status: 409, body: { error: "That Nostr key is already linked to another account." } },
    ]);
    expect(await linkLocalNostr({ ...opts, fetchImpl: impl })).toEqual({
      ok: false, reason: "link-failed", detail: "That Nostr key is already linked to another account.",
    });
  });
});
