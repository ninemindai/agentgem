// src/gem/__tests__/nostrIdentity.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadOrCreateNostrIdentity,
  nostrIdentityFromSecret,
  loadOrCreateIdentity,
  encodeBech32,
  decodeBech32,
  nostrEventId,
  verifyNostrEvent,
  type NostrEvent,
} from "@agentgem/model";

// Canonical NIP-19 spec vector — an external anchor proving the bech32 pipeline and
// pubkey derivation match other Nostr implementations (both nsec AND npub).
const SK = "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa";
const NSEC = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5";
const PK = "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e";
const NPUB = "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg";

const tmp = () => mkdtempSync(join(tmpdir(), "agentgem-nostr-"));

describe("nostrIdentity — NIP-19 encoding", () => {
  it("derives the canonical npub / nsec / pubkey from the spec secret key", () => {
    const id = nostrIdentityFromSecret(SK);
    expect(id.pubkeyHex).toBe(PK);
    expect(id.npub).toBe(NPUB);
    expect(id.nsec()).toBe(NSEC);
  });

  it("round-trips bech32 in both directions", () => {
    expect(decodeBech32(NPUB)).toEqual({ hrp: "npub", hex: PK });
    expect(decodeBech32(NSEC)).toEqual({ hrp: "nsec", hex: SK });
    expect(encodeBech32("npub", PK)).toBe(NPUB);
    expect(encodeBech32("nsec", SK)).toBe(NSEC);
  });

  it("accepts either a hex secret or an nsec (bring-your-own-key) and yields the same identity", () => {
    expect(nostrIdentityFromSecret(SK).npub).toBe(nostrIdentityFromSecret(NSEC).npub);
  });

  it("rejects a malformed secret", () => {
    expect(() => nostrIdentityFromSecret("not-a-key")).toThrow();
    expect(() => nostrIdentityFromSecret("abcd")).toThrow();
  });
});

describe("nostrIdentity — event signing (NIP-01 / BIP-340)", () => {
  const unsigned = { created_at: 1_700_000_000, kind: 1, tags: [["t", "buzz"]], content: "gm from AgentGem" };

  it("signs an event whose id commits to the content and verifies", () => {
    const id = nostrIdentityFromSecret(SK);
    const ev = id.signEvent(unsigned);
    expect(ev.pubkey).toBe(PK);
    expect(ev.id).toBe(nostrEventId(PK, unsigned)); // id is the canonical sha256
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/); // 64-byte Schnorr sig
    expect(verifyNostrEvent(ev)).toBe(true);
  });

  it("rejects a tampered event", () => {
    const ev = nostrIdentityFromSecret(SK).signEvent(unsigned);
    expect(verifyNostrEvent({ ...ev, content: "tampered" })).toBe(false); // id no longer matches
    const flipped: NostrEvent = { ...ev, sig: ev.sig.slice(0, -2) + (ev.sig.endsWith("0") ? "1" : "0") };
    expect(verifyNostrEvent(flipped)).toBe(false); // signature invalid
  });

  it("signDigest produces a 64-byte Schnorr signature over a 32-byte challenge", () => {
    const id = nostrIdentityFromSecret(SK);
    const sig = id.signDigest("a".repeat(64));
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(id.signDigest("b".repeat(64))).not.toBe(sig); // different challenge → different sig
    expect(() => id.signDigest("tooshort")).toThrow();
  });
});

describe("nostrIdentity — persistence & isolation", () => {
  it("creates the key on first load and returns the same identity thereafter", () => {
    const dir = tmp();
    const a = loadOrCreateNostrIdentity(dir);
    expect(a.npub).toMatch(/^npub1/);
    expect(a.pubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(dir, "nostr-identity.json"))).toBe(true);
    expect(loadOrCreateNostrIdentity(dir).npub).toBe(a.npub); // persisted, stable
  });

  it("writes the secret with no group/world permission bits", () => {
    const dir = tmp();
    loadOrCreateNostrIdentity(dir);
    const mode = statSync(join(dir, "nostr-identity.json")).mode;
    expect(mode & 0o077).toBe(0); // bearer secret: owner-only
  });

  it("coexists with the ed25519 attestation identity in the same dir (separate files, separate schemes)", () => {
    const dir = tmp();
    const ed = loadOrCreateIdentity(dir);
    const nostr = loadOrCreateNostrIdentity(dir);
    expect(ed.publicKey).toMatch(/^ed25519:/); // different curve
    expect(nostr.npub).toMatch(/^npub1/);
    expect(existsSync(join(dir, "identity.json"))).toBe(true);
    expect(existsSync(join(dir, "nostr-identity.json"))).toBe(true);
    // both remain stable when reloaded — neither clobbers the other
    expect(loadOrCreateIdentity(dir).publicKey).toBe(ed.publicKey);
    expect(loadOrCreateNostrIdentity(dir).npub).toBe(nostr.npub);
  });
});
