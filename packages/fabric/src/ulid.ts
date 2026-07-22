// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// ULID generation (spec: 48-bit ms timestamp + 80 random bits, Crockford base32).
// Deliberately stricter than the contract's shape validator ULID_RE: the first
// character is capped at 0-7 because 48 bits of timestamp only reach "7" in the
// top base32 digit.
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
    let ts = "";
    let t = now;
    for (let i = 0; i < 10; i++) { ts = ALPHABET[t % 32] + ts; t = Math.floor(t / 32); }
    const rand = randomBytes(16);
    let out = ts;
    for (let i = 0; i < 16; i++) out += ALPHABET[rand[i] % 32];
    return out;
}
