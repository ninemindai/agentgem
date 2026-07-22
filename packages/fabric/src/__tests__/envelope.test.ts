// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import {
    askOptionsSchema,
    assertNoSelfAcrossZones,
    assertSignedAcrossZones,
    DELIVERY_STATES,
    type Envelope,
    envelopeHeaderSchema,
    envelopeSchema,
    FABRIC_ENVELOPE_VERSION,
    fabricErrorSchema,
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

    it("requires v to be exactly the supported schema version", () => {
        expect(envelopeSchema.safeParse(validEnvelope({ v: undefined as unknown as 1 })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ v: 1.5 as unknown as 1 })).success).toBe(false);
        //  a v2 envelope must never parse as supported v1 — it parks via the header schema
        expect(envelopeSchema.safeParse(validEnvelope({ v: 2 as unknown as 1 })).success).toBe(false);
    });

    it("constrains channel ids and scope ids to real grammars", () => {
        expect(envelopeSchema.safeParse(validEnvelope({ channel: "has space" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ channel: "Upper/Case" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ channel: "org/announcements" })).success).toBe(true);
        expect(scopeSchema.safeParse({ scope: "org", id: "   " }).success).toBe(false);
        expect(scopeSchema.safeParse({ scope: "org", id: "org-ninemind" }).success).toBe(true);
    });

    it("rejects malformed ids, kinds, and addresses", () => {
        expect(envelopeSchema.safeParse(validEnvelope({ id: "not-a-ulid" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "NoDots" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "Chat.Token" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "org.foo-" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "a--b.x" })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ from: "https://x" as never })).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ kind: "repo-pulse.event" })).success).toBe(true);
    });

    it("rejects unknown extra fields (wire strictness)", () => {
        expect(envelopeSchema.safeParse({ ...(validEnvelope() as object), extra: 1 }).success).toBe(false);
    });

    it("requires payload — signal-only kinds send explicit null, never omit", () => {
        const { payload: _dropped, ...withoutPayload } = validEnvelope() as Record<string, unknown>;
        expect(envelopeSchema.safeParse(withoutPayload).success).toBe(false);
        expect(envelopeSchema.safeParse(validEnvelope({ payload: null })).success).toBe(true);
    });
});

describe("envelope header — forward-compat parse for park-and-surface", () => {
    it("reads v/id/kind off a newer envelope carrying unknown fields", () => {
        const v2 = { ...(validEnvelope() as object), v: 2, futureField: { x: 1 } };
        expect(envelopeSchema.safeParse(v2).success).toBe(false); //  strict schema rejects it...
        const header = envelopeHeaderSchema.safeParse(v2); //  ...but the header still parses,
        expect(header.success).toBe(true); //  so the router can park it visibly.
        if (header.success) expect(header.data.v).toBe(2);
    });

    it("still rejects garbage", () => {
        expect(envelopeHeaderSchema.safeParse({ v: 2 }).success).toBe(false);
        expect(envelopeHeaderSchema.safeParse({ v: "2", id: "x", kind: "k" }).success).toBe(false);
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
    it("checks to too", () => {
        const withSelfTo = envelopeSchema.parse(
            validEnvelope({ to: "agentgem://self/miniapp/x" } as Partial<Envelope>),
        );
        expect(() => assertNoSelfAcrossZones(withSelfTo, "machine", "federated")).toThrow(TypeError);
    });
});

describe("signature required at zone crossings (presence half — verification is the mailbox's)", () => {
    const unsigned = envelopeSchema.parse(validEnvelope());
    const signed = envelopeSchema.parse(
        validEnvelope({
            signature: { alg: "ed25519", pubkey: "pk", sig: "sg" },
            signedAt: "2026-07-22T00:00:00.000Z",
        } as Partial<Envelope>),
    );
    it("throws when an unsigned envelope would cross zones", () => {
        expect(() => assertSignedAcrossZones(unsigned, "machine", "federated")).toThrow(TypeError);
    });
    it("passes a signed envelope across zones and any envelope in-zone", () => {
        expect(() => assertSignedAcrossZones(signed, "machine", "federated")).not.toThrow();
        expect(() => assertSignedAcrossZones(unsigned, "in-proc", "in-proc")).not.toThrow();
    });
    it("signedAt alone is not enough", () => {
        const dated = envelopeSchema.parse(validEnvelope({ signedAt: "2026-07-22T00:00:00.000Z" } as Partial<Envelope>));
        expect(() => assertSignedAcrossZones(dated, "machine", "federated")).toThrow(TypeError);
    });
});

describe("fabric error carrier", () => {
    it("accepts the three kinds and rejects everything else", () => {
        expect(fabricErrorSchema.safeParse({ kind: "timeout", message: "no reply" }).success).toBe(true);
        expect(fabricErrorSchema.safeParse({ kind: "refused-at-gate", message: "consent denied", envelopeId: ULID }).success).toBe(true);
        expect(fabricErrorSchema.safeParse({ kind: "app-error", message: "x" }).success).toBe(false);
        expect(fabricErrorSchema.safeParse({ kind: "timeout", message: "" }).success).toBe(false);
        expect(fabricErrorSchema.safeParse({ kind: "timeout", message: "x", extra: 1 }).success).toBe(false);
    });
});
