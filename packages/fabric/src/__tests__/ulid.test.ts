// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { ULID_RE } from "../envelope.js";
import { ulid } from "../ulid.js";

describe("ulid generator", () => {
    it("emits 26-char Crockford ULIDs the contract validator accepts", () => {
        for (let i = 0; i < 200; i++) expect(ULID_RE.test(ulid())).toBe(true);
    });

    it("caps the first char at 0-7 (48-bit timestamp spec cap) — stricter than the validator", () => {
        for (let i = 0; i < 200; i++) expect("01234567".includes(ulid()[0])).toBe(true);
    });

    it("encodes time ordering across distinct milliseconds", () => {
        expect(ulid(1_000_000) < ulid(2_000_000_000_000)).toBe(true);
    });

    it("never collides across a burst", () => {
        const seen = new Set(Array.from({ length: 500 }, () => ulid()));
        expect(seen.size).toBe(500);
    });
});
