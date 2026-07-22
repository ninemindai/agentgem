// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The one envelope every fabric message rides (docs/proposals/message-fabric.md
// §Envelope). Versioned because cross-install skew is the steady state; unknown
// versions/kinds are parked-and-surfaced by the router (increment 2), never dropped.
// Signing SEMANTICS are normative in docs/proposals/actor-inbox-outbox.md — this file
// only carries the bytes.
import { z } from "zod";
import { addressSchema, isSelfAddress, rootIdSchema } from "./address.js";
import { isZoneCrossing, type Zone } from "./zone.js";

export const FABRIC_ENVELOPE_VERSION = 1;

// Crockford base32 ULID (26 chars). Generation is runtime (increment 2); the
// contract only validates shape.
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Registered kinds are dotted lowercase, dashes interior-only: chat.token, repo-pulse.event.
export const KIND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/;

// Channel ids are slash-separated lowercase segments, dashes interior-only:
// chat/turn-42, org/announcements. One grammar shared by envelopes and channel
// declarations so routing keys, cursors, and signed envelopes can never disagree
// on normalization.
export const CHANNEL_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*(\/[a-z0-9]+(-[a-z0-9]+)*)*$/;
export const channelIdSchema = z.string().regex(CHANNEL_ID_RE, "not a channel id");

export const signatureSchema = z
    .object({ alg: z.literal("ed25519"), pubkey: z.string().min(1), sig: z.string().min(1) })
    .strict();
export type EnvelopeSignature = z.infer<typeof signatureSchema>;

// Audience scopes (proposal §Addresses): friend/group/org name a target and need its
// id; self/public are absolute and take none. Ids reuse the address root grammar so
// scopes never become a second, looser address system.
export const scopeSchema = z.union([
    z.object({ scope: z.enum(["friend", "group", "org"]), id: rootIdSchema }).strict(),
    z.object({ scope: z.enum(["self", "public"]) }).strict(),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const envelopeSchema = z
    .object({
        // The SUPPORTED version, exactly — a v:2 envelope must fail this schema and be
        // parked via envelopeHeaderSchema, never processed under v1 semantics.
        v: z.literal(FABRIC_ENVELOPE_VERSION),
        id: z.string().regex(ULID_RE, "id must be a ULID"),
        kind: z.string().regex(KIND_RE, "kind must be dotted lowercase"),
        from: addressSchema,
        to: z.union([addressSchema, scopeSchema]),
        correlationId: z.string().regex(ULID_RE).optional(),
        replyTo: addressSchema.optional(),
        channel: channelIdSchema,
        // Required: signal-only kinds (e.g. fabric.gap) send an explicit null, never omit.
        payload: z.unknown(),
        signature: signatureSchema.optional(),
        signedAt: z.iso.datetime().optional(),
    })
    .strict();
export type Envelope = z.infer<typeof envelopeSchema>;

// Forward-compat parse path for park-and-surface: a newer-versioned envelope may
// carry fields this install's strict schema rejects, but the router must still read
// enough to park it visibly ("needs a newer version") instead of dropping bytes.
// Loose by design — unknown keys tolerated, only the header fields validated.
export const envelopeHeaderSchema = z
    .looseObject({
        v: z.number().int().positive(),
        id: z.string().regex(ULID_RE),
        kind: z.string().min(1),
    });
export type EnvelopeHeader = z.infer<typeof envelopeHeaderSchema>;

// ask() durability follows zone (proposal §Verbs): in-zone asks are in-memory with a
// timeout; cross-zone asks are feed-backed with a deadline. The XOR is the contract —
// a call site can never be ambiguous about which primitive it is using.
export const askOptionsSchema = z.union([
    z.object({ timeoutMs: z.number().int().positive() }).strict(),
    z.object({ deadline: z.iso.datetime() }).strict(),
]);
export type AskOptions = z.infer<typeof askOptionsSchema>;

// ask() fails exactly three ways at the fabric layer. Application-level errors are
// reply payloads, never fabric errors.
export const FABRIC_ERROR_KINDS = ["timeout", "refused-at-gate", "transport"] as const;
export type FabricErrorKind = (typeof FABRIC_ERROR_KINDS)[number];

// The contract-level error shape adapters construct and match on. The router
// (increment 2) throws/returns these; application-level errors are reply payloads
// and never use this shape.
export const fabricErrorSchema = z
    .object({
        kind: z.enum(FABRIC_ERROR_KINDS),
        message: z.string().min(1),
        envelopeId: z.string().regex(ULID_RE).optional(),
    })
    .strict();
export type FabricError = z.infer<typeof fabricErrorSchema>;

// Sender-visible delivery states for cross-zone sends (proposal §Error handling).
export const DELIVERY_STATES = ["pending", "delivering", "delivered", "refused", "expired", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

// `self` is router-local: signatures must bind absolute addresses, so an envelope on
// a zone-crossing hop must not name `self` anywhere routable. Scope-form `to`
// ({scope: "self"}) is deliberately out of scope here: scopes are resolved to
// concrete addresses by the router before any hop, so only address strings are
// checked.
export function assertNoSelfAcrossZones(envelope: Envelope, fromZone: Zone, toZone: Zone): void {
    if (!isZoneCrossing(fromZone, toZone)) return;
    const routable = [envelope.from, typeof envelope.to === "string" ? envelope.to : undefined, envelope.replyTo];
    for (const address of routable) {
        if (address !== undefined && isSelfAddress(address)) {
            throw new TypeError(`self address may not cross zones (${fromZone} -> ${toZone}): ${address}`);
        }
    }
}

// Signature REQUIRED at zone crossings (proposal §Envelope) — the presence half of
// that rule, as a pure check every link applies identically instead of hand-rolling.
// Cryptographic verification (key resolution, canonical bytes, authority) stays
// normative in docs/proposals/actor-inbox-outbox.md and is NOT this function's job.
export function assertSignedAcrossZones(envelope: Envelope, fromZone: Zone, toZone: Zone): void {
    if (!isZoneCrossing(fromZone, toZone)) return;
    if (envelope.signature === undefined || envelope.signedAt === undefined) {
        throw new TypeError(`zone-crossing envelope must carry signature and signedAt (${fromZone} -> ${toZone}): ${envelope.id}`);
    }
}
