// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { channelSchema, GAP_KIND } from "../channel.js";
import { KIND_RE } from "../envelope.js";

const base = { id: "org/announcements", kinds: ["org.announcement"], zones: ["federated"] };

describe("channel declarations", () => {
    it("accepts a stream with no retention", () => {
        expect(channelSchema.safeParse({ ...base, id: "chat/turn-42", class: "stream" }).success).toBe(true);
    });

    it("rejects retention on a stream", () => {
        expect(
            channelSchema.safeParse({ ...base, class: "stream", retention: { maxEntries: 10 } }).success,
        ).toBe(false);
    });

    it("feed requires bounded retention or an explicit justification", () => {
        expect(channelSchema.safeParse({ ...base, class: "feed" }).success).toBe(false);
        expect(channelSchema.safeParse({ ...base, class: "feed", retention: {} }).success).toBe(false);
        expect(channelSchema.safeParse({ ...base, class: "feed", retention: { maxAgeMs: 86_400_000 } }).success).toBe(true);
        expect(channelSchema.safeParse({ ...base, class: "feed", retention: { maxEntries: 10_000 } }).success).toBe(true);
        expect(
            channelSchema.safeParse({ ...base, class: "feed", retention: { unbounded: "audit log, org policy" } }).success,
        ).toBe(true);
        expect(channelSchema.safeParse({ ...base, class: "feed", retention: { unbounded: "" } }).success).toBe(false);
    });

    it("validates kinds and zones", () => {
        expect(channelSchema.safeParse({ ...base, class: "stream", kinds: ["NotAKind"] }).success).toBe(false);
        expect(channelSchema.safeParse({ ...base, class: "stream", zones: ["network"] }).success).toBe(false);
        expect(channelSchema.safeParse({ ...base, class: "stream", kinds: [] }).success).toBe(false);
    });

    it("exposes the explicit gap kind", () => {
        expect(GAP_KIND).toBe("fabric.gap");
        expect(KIND_RE.test(GAP_KIND)).toBe(true);
    });
});
