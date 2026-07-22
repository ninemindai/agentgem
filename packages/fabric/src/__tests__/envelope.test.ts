// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
    askOptionsSchema,
    assertNoSelfAcrossZones,
    DELIVERY_STATES,
    type Envelope,
    envelopeSchema,
    FABRIC_ENVELOPE_VERSION,
    FABRIC_ERROR_KINDS,
    scopeSchema,
} from "../envelope.js";

const ULID = "01J8ZC9E2N4Q6R8T0V2X4Z6B8D";

function validEnvelope(overrides: Partial<Envelope> = {}): unknown {
    return {
        v: FABRIC_ENVELOPE_VERSION,
        id: ULID,
        kind: "chat.token",
        from: "agentgem://inst-a1b2/agent/goldmine",
        to: "agentgem://inst-a1b2/miniapp/repo-pulse/ui",
        channel: "chat/turn-42",
        payload: { text: "hi" },
        ...overrides,
    };
}

describe("envelope schema", () => {
    it("accepts a minimal valid envelope", () => {
        expect(envelopeSchema.safeParse(validEnvelope()).success).toBe(true);
    });

    it("accepts a scope recipient and optional signature fields", () => {
        const parsed = envelopeSchema.safeParse(
            validEnvelope({
                to: { scope: "org", id: "org-ninemind" },
                correlationId: ULID,
                replyTo: "agentgem://inst-a1b2/agent/goldmine",
                signature: { alg: "ed25519", pubkey: "pk", sig: "sg" },
                signedAt: "2026-07-22T00:00:00.000Z",
            } as Partial<Envelope>),
        );
        expect(parsed.success).toBe(true);
    });

    it("requires v to be the integer schema version", () => {
        expect(envelopeSchema.safeParse(validEnvelope({ v: undefined as unknown as number })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ v: 1.5 })).success).toBe(false);
    });

    it("rejects malformed ids, kinds, and addresses", () => {
        expect(envelopeSchema.safeParse(validEnvelope({ id: "not-a-ulid" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "NoDots" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "Chat.Token" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ from: "https://x" as never })).success).toBe(false);
    });

    it("rejects unknown extra fields (wire strictness)", () => {
        expect(envelopeSchema.safeParse({ ...(validEnvelope() as object), extra: 1 }).success).toBe(false);
    });
});

describe("scope schema", () => {
    it("friend/group/org require an id; self/public forbid it", () => {
        expect(scopeSchema.safeParse({ scope: "friend", id: "inst-b" }).success).toBe(true);
        expect(scopeSchema.safeParse({ scope: "friend" }).success).toBe(false);
        expect(scopeSchema.safeParse({ scope: "public" }).success).toBe(true);
        expect(scopeSchema.safeParse({ scope: "public", id: "x" }).success).toBe(false);
        expect(scopeSchema.safeParse({ scope: "self" }).success).toBe(true);
    });
});

describe("ask options — durability follows zone, enforced at the type level", () => {
    it("accepts exactly one of timeoutMs / deadline", () => {
        expect(askOptionsSchema.safeParse({ timeoutMs: 5000 }).success).toBe(true);
        expect(askOptionsSchema.safeParse({ deadline: "2026-08-01T00:00:00.000Z" }).success).toBe(true);
        expect(askOptionsSchema.safeParse({ timeoutMs: 5000, deadline: "2026-08-01T00:00:00.000Z" }).success).toBe(false);
        expect(askOptionsSchema.safeParse({}).success).toBe(false);
    });
});

describe("error and delivery-state vocabularies", () => {
    it("ask fails exactly three ways at the fabric layer", () => {
        expect(FABRIC_ERROR_KINDS).toEqual(["timeout", "refused-at-gate", "transport"]);
    });
    it("sender-visible delivery states", () => {
        expect(DELIVERY_STATES).toEqual(["pending", "delivering", "delivered", "refused", "expired", "failed"]);
    });
});

describe("self addresses never cross zones", () => {
    const env = envelopeSchema.parse(validEnvelope({ from: "agentgem://self/agent/goldmine" }));
    it("throws on a crossing hop", () => {
        expect(() => assertNoSelfAcrossZones(env, "machine", "federated")).toThrow(TypeError);
    });
    it("allows the same hop in-zone", () => {
        expect(() => assertNoSelfAcrossZones(env, "machine", "machine")).not.toThrow();
    });
    it("checks replyTo too", () => {
        const withReply = envelopeSchema.parse(
            validEnvelope({ replyTo: "agentgem://self/agent/goldmine" } as Partial<Envelope>),
        );
        expect(() => assertNoSelfAcrossZones(withReply, "machine", "federated")).toThrow(TypeError);
    });
});
