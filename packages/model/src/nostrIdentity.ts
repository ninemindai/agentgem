// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/model/src/nostrIdentity.ts
//
// A Nostr (secp256k1 / BIP-340 Schnorr) identity — the Buzz-facing identity for a
// gem/agent/companion that participates on a Nostr relay. This is DELIBERATELY
// SEPARATE from the ed25519 attestation identity in identity.ts: Nostr uses a
// different curve and signature scheme, so the two keys never interconvert. An
// AgentGem entity that lives on Buzz holds BOTH — ed25519 for the AgentGem
// attestation chain, secp256k1 here for its npub.
//
// The secret key is a bearer credential (whoever holds it *is* this identity on any
// relay), so persistence mirrors loadOrCreateIdentity's hardening exactly.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bech32 } from "@scure/base";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, lstatSync, chmodSync, openSync, readSync, fstatSync, fchmodSync, closeSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const toHex = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const isKey32 = (h: string): boolean => /^[0-9a-f]{64}$/i.test(h);

// NIP-19 uses a generous bech32 length limit (the default 90 is too small for the
// longer TLV forms). npub/nsec are short, but keep the high limit for parity.
const BECH32_LIMIT = 1023;

/** NIP-19 bech32 encode of a 32-byte hex key under an hrp ("npub" | "nsec"). */
export function encodeBech32(hrp: "npub" | "nsec", hex32: string): string {
  if (!isKey32(hex32)) throw new Error(`not a 32-byte hex key: ${hex32.slice(0, 12)}…`);
  return bech32.encode(hrp, bech32.toWords(fromHex(hex32)), BECH32_LIMIT);
}

/** Decode a NIP-19 npub/nsec back to its hrp + 32-byte hex key. */
export function decodeBech32(s: string): { hrp: string; hex: string } {
  const { prefix, words } = bech32.decode(s as `${string}1${string}`, BECH32_LIMIT);
  return { hrp: prefix, hex: toHex(bech32.fromWords(words)) };
}

export interface UnsignedEvent { created_at: number; kind: number; tags: string[][]; content: string }
export interface NostrEvent extends UnsignedEvent { id: string; pubkey: string; sig: string }

/** NIP-01 event id: sha256 over the canonical [0, pubkey, created_at, kind, tags, content] JSON array. */
export function nostrEventId(pubkeyHex: string, e: UnsignedEvent): string {
  const serial = JSON.stringify([0, pubkeyHex, e.created_at, e.kind, e.tags, e.content]);
  return createHash("sha256").update(Buffer.from(serial, "utf8")).digest("hex");
}

/** Verify a finalized Nostr event: id integrity + BIP-340 Schnorr signature. */
export function verifyNostrEvent(e: NostrEvent): boolean {
  try {
    if (nostrEventId(e.pubkey, e) !== e.id) return false; // id must commit to the content
    return schnorr.verify(fromHex(e.sig), fromHex(e.id), fromHex(e.pubkey));
  } catch {
    return false;
  }
}

export interface NostrIdentity {
  /** 32-byte x-only public key, lowercase hex — Nostr's canonical id. */
  pubkeyHex: string;
  /** bech32 npub (NIP-19) — the shareable public identity. */
  npub: string;
  /** Finalize a Nostr event (NIP-01): fills in id, pubkey, and sig. */
  signEvent(e: UnsignedEvent): NostrEvent;
  /** Raw BIP-340 Schnorr signature (hex) over a 32-byte hex digest (e.g. a NIP-42 challenge). */
  signDigest(digestHex: string): string;
  /** The secret key as a NIP-19 nsec — a BEARER SECRET. Treat like a password; never log or transmit. */
  nsec(): string;
}

function identityFromSecretHex(skHex: string): NostrIdentity {
  const sk = fromHex(skHex);
  const pubkeyHex = toHex(schnorr.getPublicKey(sk));
  return {
    pubkeyHex,
    npub: encodeBech32("npub", pubkeyHex),
    signEvent(e) {
      const id = nostrEventId(pubkeyHex, e);
      return { ...e, id, pubkey: pubkeyHex, sig: toHex(schnorr.sign(fromHex(id), sk)) };
    },
    signDigest(digestHex) {
      if (!isKey32(digestHex)) throw new Error("signDigest expects a 32-byte hex digest");
      return toHex(schnorr.sign(fromHex(digestHex), sk));
    },
    nsec() { return encodeBech32("nsec", skHex); },
  };
}

/** Reconstruct an identity from an existing secret — hex or an `nsec1…` (bring-your-own-key / interop). */
export function nostrIdentityFromSecret(secret: string): NostrIdentity {
  const skHex = secret.startsWith("nsec1") ? decodeBech32(secret).hex : secret;
  if (!isKey32(skHex)) throw new Error("invalid Nostr secret key (want 32-byte hex or nsec1…)");
  return identityFromSecretHex(skHex.toLowerCase());
}

interface NostrKeyFile { skHex: string }

/**
 * Load or create the local Nostr identity (secp256k1 secret key) at
 * `<dir>/nostr-identity.json`. Mirrors loadOrCreateIdentity's file hardening — the
 * secret is a bearer credential: 0700 dir, 0600 file, symlink-guarded, O_NOFOLLOW
 * open, and create-race safe.
 */
export function loadOrCreateNostrIdentity(dir = join(homedir(), ".agentgem")): NostrIdentity {
  const file = join(dir, "nostr-identity.json");

  // Guard the directory: reject a symlink, tighten group/world bits if present.
  try {
    const ds = lstatSync(dir);
    if (ds.isSymbolicLink()) throw new Error("identity dir is a symlink; refusing");
    if (ds.mode & 0o077) chmodSync(dir, 0o700);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // O_NOFOLLOW closes the lstat→open TOCTOU window: the open fails (ELOOP) if the
  // final path component is a symlink.
  const readViaFd = (): NostrKeyFile => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (st.mode & 0o077) fchmodSync(fd, 0o600);
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      return JSON.parse(buf.toString("utf8")) as NostrKeyFile;
    } finally {
      closeSync(fd);
    }
  };

  let kf: NostrKeyFile;
  try {
    kf = readViaFd();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw e; // ELOOP (symlink) or other → propagate
    kf = { skHex: toHex(schnorr.keygen().secretKey) };
    try {
      writeFileSync(file, JSON.stringify(kf), { mode: 0o600, flag: "wx" });
    } catch (we) {
      if ((we as NodeJS.ErrnoException).code !== "EEXIST") throw we;
      kf = readViaFd(); // race: another process wrote it first
    }
  }
  if (!isKey32(kf.skHex)) throw new Error("corrupt nostr-identity.json: skHex is not 32-byte hex");
  return identityFromSecretHex(kf.skHex.toLowerCase());
}
