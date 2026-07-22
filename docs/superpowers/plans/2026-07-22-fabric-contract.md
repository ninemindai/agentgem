# @agentgem/fabric Contract Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship increment 1 of the message fabric (`docs/proposals/message-fabric.md`): the `@agentgem/fabric` package containing the envelope, address, zone, channel, and kind-registry contract — zod-typed, no router runtime.

**Architecture:** A new leaf workspace package mirroring `packages/contract`'s shape (composite tsc, `src → dist`, ESM). Pure types + zod schemas + small pure helpers (parse/format/validate), exactly like `@agentgem/contract` ships signing-payload builder functions. No router, no I/O, no transports. Tests live in `src/__tests__/` and run compiled from `dist` via the root vitest config (the `packages/app` pattern — the only pattern the CI gate `pnpm test` actually runs).

**Tech Stack:** TypeScript 5 (composite build, module nodenext), zod ^4.4.3, vitest (root config).

## Global Constraints

- **Spec authority:** `docs/proposals/message-fabric.md` §Envelope/§Addresses/§Trust zones/§Authorization/§Channels/§Verbs; decided rules must land exactly (no weakening):
  - Envelope has `v` (schema version); current version constant is `1`.
  - Kinds are registered: owner + zod payload schema + version; duplicates rejected.
  - `self` is router-local: an envelope that would cross a zone must not contain a `self` address (pure validator here; enforcement wiring is increment 2).
  - Zones: `in-proc`, `sealed`, `machine`, `owned-devices`, `federated` — sealed is a trust boundary inside the machine.
  - Channels: `stream` (no retention) vs `feed` (bounded retention required, or an explicit `unbounded` justification string).
  - Ask options are a type-level discriminated union: `{ timeoutMs }` (in-zone) XOR `{ deadline }` (cross-zone, ISO string).
  - Fabric errors are exactly three kinds: `timeout`, `refused-at-gate`, `transport`.
  - Delivery states: `pending | delivering | delivered | refused | expired | failed`.
- **No runtime:** no router, no timers, no I/O, no side effects at import. Pure functions and schemas only.
- **Dependency limit:** `zod` only. No ulid package — the id format is validated by regex; generation is increment 2.
- **File conventions:** every `src/*.ts` starts with the two-line license header used by `packages/contract/src/catalog.ts`:
  ```
  // Copyright (c) 2026 NineMind, Inc.
  // SPDX-License-Identifier: MIT
  ```
- **CI gate:** root `pnpm build && pnpm test` must stay green; the new tests MUST be discovered by the root vitest config (verify the count grows).
- Commit messages: `feat(fabric): …` / `test(fabric): …`, each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Package scaffold + build/test wiring

**Files:**
- Create: `packages/fabric/package.json`
- Create: `packages/fabric/tsconfig.json`
- Create: `packages/fabric/src/index.ts`
- Create: `packages/fabric/src/__tests__/smoke.test.ts`
- Modify: root `tsconfig.json` (add `packages/fabric` to `references`)
- Modify: root `vitest.config.ts` (add `packages/fabric/dist/**/__tests__/**/*.test.js` to `include`)

**Interfaces:**
- Consumes: nothing.
- Produces: the buildable, test-discovered package skeleton. Later tasks add modules under `packages/fabric/src/` and re-export from `src/index.ts`.

- [ ] **Step 1: Create `packages/fabric/package.json`**

```json
{
  "name": "@agentgem/fabric",
  "version": "0.1.0",
  "description": "The message-fabric contract — envelope, addresses, zones, channels, and the kind registry. Types and zod schemas only; the router lands separately.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b"
  },
  "dependencies": {
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 2: Create `packages/fabric/tsconfig.json`** (mirror of `packages/contract/tsconfig.json`, no references)

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022"],
    "types": ["node"],
    "strict": true,
    "strictPropertyInitialization": false,
    "useUnknownInCatchVariables": false,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "composite": true,
    "declaration": true,
    "rootDir": "src",
    "outDir": "dist",
    "incremental": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules"]
}
```

- [ ] **Step 3: Create `packages/fabric/src/index.ts`** (placeholder export so the package compiles; later tasks replace this file's contents with real re-exports)

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The message-fabric contract package. See docs/proposals/message-fabric.md.
export const FABRIC_ENVELOPE_VERSION = 1;
```

- [ ] **Step 4: Create the smoke test** `packages/fabric/src/__tests__/smoke.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { FABRIC_ENVELOPE_VERSION } from "../index.js";

describe("@agentgem/fabric package wiring", () => {
    it("compiles and is discovered by the root vitest config", () => {
        expect(FABRIC_ENVELOPE_VERSION).toBe(1);
    });
});
```

- [ ] **Step 5: Wire into root `tsconfig.json`**

In the root `tsconfig.json` `references` array, add (alphabetical placement not required — append after the `packages/contract` entry to keep related packages adjacent):

```json
    {
      "path": "packages/fabric"
    },
```

- [ ] **Step 6: Wire into root `vitest.config.ts`**

Change the `include` line to:

```ts
    include: ["dist/**/__tests__/**/*.test.js", "packages/app/dist/**/__tests__/**/*.test.js", "packages/fabric/dist/**/__tests__/**/*.test.js", "website/edge/**/*.test.js"],
```

- [ ] **Step 7: Install + build + verify discovery**

Run: `pnpm install` (links the new workspace package; updates `pnpm-lock.yaml` — commit it)
Run: `pnpm build`
Expected: compiles; `packages/fabric/dist/index.js` and `dist/__tests__/smoke.test.js` exist.
Run: `pnpm vitest run packages/fabric/dist/__tests__/smoke.test.js`
Expected: `1 passed`.

- [ ] **Step 8: Commit**

```bash
git add packages/fabric pnpm-lock.yaml tsconfig.json vitest.config.ts
git commit -m "feat(fabric): scaffold @agentgem/fabric contract package

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 2: Addresses and zones

**Files:**
- Create: `packages/fabric/src/address.ts`
- Create: `packages/fabric/src/zone.ts`
- Test: `packages/fabric/src/__tests__/address.test.ts`, `packages/fabric/src/__tests__/zone.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 3/4 rely on these exact names):
  - `type Zone = "in-proc" | "sealed" | "machine" | "owned-devices" | "federated"`; `const zoneSchema: z.ZodType<Zone>`; `function isZoneCrossing(a: Zone, b: Zone): boolean`
  - `const ADDRESS_SCHEME = "agentgem://"`; `const SELF_ROOT = "self"`
  - `interface ParsedAddress { root: string; path: string[] }`
  - `const addressSchema: z.ZodString` (validates the full `agentgem://root[/seg]*` shape)
  - `function parseAddress(address: string): ParsedAddress` (throws `TypeError` on malformed input)
  - `function formatAddress(parsed: ParsedAddress): string`
  - `function isSelfAddress(address: string): boolean`

- [ ] **Step 1: Write the failing tests** `packages/fabric/src/__tests__/address.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { addressSchema, formatAddress, isSelfAddress, parseAddress, SELF_ROOT } from "../address.js";

describe("address parsing", () => {
    it("parses a root-only address", () => {
        expect(parseAddress("agentgem://inst-a1b2")).toEqual({ root: "inst-a1b2", path: [] });
    });

    it("parses sub-paths", () => {
        expect(parseAddress("agentgem://inst-a1b2/agent/goldmine")).toEqual({
            root: "inst-a1b2",
            path: ["agent", "goldmine"],
        });
        expect(parseAddress("agentgem://org-ninemind/governance")).toEqual({
            root: "org-ninemind",
            path: ["governance"],
        });
    });

    it("round-trips through formatAddress", () => {
        for (const a of ["agentgem://self", "agentgem://self/mcp/github", "agentgem://inst-a1b2/miniapp/repo-pulse/ui"]) {
            expect(formatAddress(parseAddress(a))).toBe(a);
        }
    });

    it("rejects malformed addresses", () => {
        for (const bad of [
            "",
            "inst-a1b2", //  missing scheme
            "agentgem://", //  empty root
            "agentgem://UPPER", //  uppercase root
            "agentgem://inst a1b2", //  whitespace
            "agentgem://inst-a1b2//agent", //  empty segment
            "agentgem://inst-a1b2/agent/", //  trailing slash
            "https://inst-a1b2", //  wrong scheme
        ]) {
            expect(() => parseAddress(bad), bad).toThrow(TypeError);
            expect(addressSchema.safeParse(bad).success, bad).toBe(false);
        }
    });

    it("addressSchema accepts what parseAddress accepts", () => {
        for (const good of ["agentgem://self", "agentgem://inst-a1b2/agent/goldmine"]) {
            expect(addressSchema.safeParse(good).success, good).toBe(true);
        }
    });

    it("identifies self addresses", () => {
        expect(isSelfAddress("agentgem://self")).toBe(true);
        expect(isSelfAddress("agentgem://self/mcp/github")).toBe(true);
        expect(isSelfAddress("agentgem://inst-a1b2")).toBe(false);
        expect(SELF_ROOT).toBe("self");
    });
});
```

`packages/fabric/src/__tests__/zone.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { isZoneCrossing, ZONES, zoneSchema } from "../zone.js";

describe("zones", () => {
    it("declares exactly the five zones from the proposal", () => {
        expect(ZONES).toEqual(["in-proc", "sealed", "machine", "owned-devices", "federated"]);
    });

    it("same zone is not a crossing; any differing pair is", () => {
        for (const z of ZONES) expect(isZoneCrossing(z, z), z).toBe(false);
        expect(isZoneCrossing("in-proc", "machine")).toBe(true);
        expect(isZoneCrossing("machine", "in-proc")).toBe(true);
        //  sealed is a trust boundary INSIDE the machine — sealed→machine is a crossing:
        expect(isZoneCrossing("sealed", "machine")).toBe(true);
        expect(isZoneCrossing("machine", "federated")).toBe(true);
    });

    it("zoneSchema rejects unknown zones", () => {
        expect(zoneSchema.safeParse("network").success).toBe(false);
        expect(zoneSchema.safeParse("machine").success).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm build 2>&1 | tail -5`
Expected: FAIL — `../address.js` and `../zone.js` do not exist (tsc error TS2307).

- [ ] **Step 3: Implement** `packages/fabric/src/zone.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Trust zones (docs/proposals/message-fabric.md §Trust zones). Zones are trust
// boundaries, not network distance — "sealed" is local-but-untrusted code (miniapps,
// MCP servers) living inside the machine behind a capability bridge.
import { z } from "zod";

export const ZONES = ["in-proc", "sealed", "machine", "owned-devices", "federated"] as const;
export type Zone = (typeof ZONES)[number];
export const zoneSchema = z.enum(ZONES);

// A crossing is any traffic between two distinct zones. Concentric containment does
// not exempt a pair: sealed→machine crosses (that's the miniapp bridge), and every
// crossing is where the mailbox's gate machinery attaches (normative in
// docs/proposals/actor-inbox-outbox.md — not here).
export function isZoneCrossing(a: Zone, b: Zone): boolean {
    return a !== b;
}
```

`packages/fabric/src/address.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Hierarchical fabric addresses (docs/proposals/message-fabric.md §Addresses):
// agentgem://<root>[/<segment>]*. Roots are federated identities holding keys;
// sub-paths are routing AND audit identity, never federated identity.
import { z } from "zod";

export const ADDRESS_SCHEME = "agentgem://";
export const SELF_ROOT = "self";

// Roots and segments: lowercase alphanumerics with interior dashes (inst-a1b2,
// org-ninemind, mcp, repo-pulse). No uppercase, no empty segments, no trailing slash.
const SEGMENT = "[a-z0-9][a-z0-9-]*";
const ADDRESS_RE = new RegExp(`^agentgem://${SEGMENT}(/${SEGMENT})*$`);

export const addressSchema = z.string().regex(ADDRESS_RE, "not an agentgem:// address");

export interface ParsedAddress {
    root: string;
    path: string[];
}

export function parseAddress(address: string): ParsedAddress {
    if (!ADDRESS_RE.test(address)) throw new TypeError(`malformed fabric address: ${JSON.stringify(address)}`);
    const [root, ...path] = address.slice(ADDRESS_SCHEME.length).split("/");
    return { root, path };
}

export function formatAddress(parsed: ParsedAddress): string {
    return ADDRESS_SCHEME + [parsed.root, ...parsed.path].join("/");
}

// `self` is a router-local alias resolved to the real root id at send time. A
// zone-crossing envelope still containing `self` is a contract violation — signatures
// must bind absolute addresses (see envelope.ts assertNoSelfAcrossZones).
export function isSelfAddress(address: string): boolean {
    return parseAddress(address).root === SELF_ROOT;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/fabric/dist/__tests__/address.test.js packages/fabric/dist/__tests__/zone.test.js`
Expected: PASS (all tests, 2 files).

- [ ] **Step 5: Commit**

```bash
git add packages/fabric/src
git commit -m "feat(fabric): addresses and trust zones

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 3: Envelope, scopes, ask options, errors, delivery states

**Files:**
- Create: `packages/fabric/src/envelope.ts`
- Test: `packages/fabric/src/__tests__/envelope.test.ts`

**Interfaces:**
- Consumes: `addressSchema`, `isSelfAddress`, `Zone`, `isZoneCrossing` from Task 2 (exact names above).
- Produces (Task 4/5 and increment 2 rely on):
  - `const FABRIC_ENVELOPE_VERSION = 1`
  - `const scopeSchema` / `type Scope = { scope: "self" | "friend" | "group" | "org" | "public"; id?: string }` (`friend`/`group`/`org` REQUIRE `id`; `self`/`public` forbid it)
  - `const envelopeSchema` / `type Envelope` — fields exactly: `v, id, kind, from, to, correlationId?, replyTo?, channel, payload, signature?, signedAt?`
  - `const signatureSchema` / `type EnvelopeSignature = { alg: "ed25519"; pubkey: string; sig: string }` (an opaque carrier — signing semantics are normative in the mailbox proposal, not here)
  - `const KIND_RE` (dotted lowercase kinds: `chat.token`, `mcp.tool.call`)
  - `const ULID_RE` (Crockford base32, 26 chars)
  - `type AskOptions = { timeoutMs: number } | { deadline: string }` with `const askOptionsSchema` (strict XOR — an object carrying both must fail)
  - `const FABRIC_ERROR_KINDS = ["timeout", "refused-at-gate", "transport"] as const`; `type FabricErrorKind`
  - `const DELIVERY_STATES = ["pending", "delivering", "delivered", "refused", "expired", "failed"] as const`; `type DeliveryState`
  - `function assertNoSelfAcrossZones(envelope: Envelope, fromZone: Zone, toZone: Zone): void` — throws `TypeError` if the hop is a zone crossing and `from`/`to`/`replyTo` contains a `self` address

- [ ] **Step 1: Write the failing test** `packages/fabric/src/__tests__/envelope.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | tail -5`
Expected: FAIL — `../envelope.js` does not exist.

- [ ] **Step 3: Implement** `packages/fabric/src/envelope.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The one envelope every fabric message rides (docs/proposals/message-fabric.md
// §Envelope). Versioned because cross-install skew is the steady state; unknown
// versions/kinds are parked-and-surfaced by the router (increment 2), never dropped.
// Signing SEMANTICS are normative in docs/proposals/actor-inbox-outbox.md — this file
// only carries the bytes.
import { z } from "zod";
import { addressSchema, isSelfAddress } from "./address.js";
import { isZoneCrossing, type Zone } from "./zone.js";

export const FABRIC_ENVELOPE_VERSION = 1;

// Crockford base32 ULID (26 chars). Generation is runtime (increment 2); the
// contract only validates shape.
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Registered kinds are dotted lowercase: chat.token, gem.published, mcp.tool.call.
export const KIND_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

export const signatureSchema = z
    .object({ alg: z.literal("ed25519"), pubkey: z.string().min(1), sig: z.string().min(1) })
    .strict();
export type EnvelopeSignature = z.infer<typeof signatureSchema>;

// Audience scopes (proposal §Addresses): friend/group/org name a target and need its
// id; self/public are absolute and take none.
export const scopeSchema = z.union([
    z.object({ scope: z.enum(["friend", "group", "org"]), id: z.string().min(1) }).strict(),
    z.object({ scope: z.enum(["self", "public"]) }).strict(),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const envelopeSchema = z
    .object({
        v: z.number().int().positive(),
        id: z.string().regex(ULID_RE, "id must be a ULID"),
        kind: z.string().regex(KIND_RE, "kind must be dotted lowercase"),
        from: addressSchema,
        to: z.union([addressSchema, scopeSchema]),
        correlationId: z.string().regex(ULID_RE).optional(),
        replyTo: addressSchema.optional(),
        channel: z.string().min(1),
        payload: z.unknown(),
        signature: signatureSchema.optional(),
        signedAt: z.iso.datetime().optional(),
    })
    .strict();
export type Envelope = z.infer<typeof envelopeSchema>;

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

// Sender-visible delivery states for cross-zone sends (proposal §Error handling).
export const DELIVERY_STATES = ["pending", "delivering", "delivered", "refused", "expired", "failed"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

// `self` is router-local: signatures must bind absolute addresses, so an envelope on
// a zone-crossing hop must not name `self` anywhere routable.
export function assertNoSelfAcrossZones(envelope: Envelope, fromZone: Zone, toZone: Zone): void {
    if (!isZoneCrossing(fromZone, toZone)) return;
    const routable = [envelope.from, typeof envelope.to === "string" ? envelope.to : undefined, envelope.replyTo];
    for (const address of routable) {
        if (address !== undefined && isSelfAddress(address)) {
            throw new TypeError(`self address may not cross zones (${fromZone} -> ${toZone}): ${address}`);
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/fabric/dist/__tests__/envelope.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fabric/src
git commit -m "feat(fabric): envelope, scopes, ask options, error and delivery vocabularies

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 4: Channels (stream vs feed, bounded retention)

**Files:**
- Create: `packages/fabric/src/channel.ts`
- Test: `packages/fabric/src/__tests__/channel.test.ts`

**Interfaces:**
- Consumes: `zoneSchema` (Task 2), `KIND_RE` (Task 3).
- Produces:
  - `const channelSchema` / `type ChannelDeclaration` — discriminated on `class: "stream" | "feed"`; both carry `{ id: string; kinds: string[]; zones: Zone[] }`; feed adds `retention`.
  - `type FeedRetention = { maxAgeMs?: number; maxEntries?: number } | { unbounded: string }` — bounded requires at least one limit; `unbounded` carries a non-empty justification string.
  - `const GAP_KIND = "fabric.gap"` — the kind a subscriber receives when its cursor falls behind the retention horizon (explicit gap, never a silent hole).

- [ ] **Step 1: Write the failing test** `packages/fabric/src/__tests__/channel.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { channelSchema, GAP_KIND } from "../channel.js";

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
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | tail -5`
Expected: FAIL — `../channel.js` does not exist.

- [ ] **Step 3: Implement** `packages/fabric/src/channel.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Channel declarations (docs/proposals/message-fabric.md §Channels). Channels are
// declared, not ad-hoc: class (stream = ephemeral, feed = durable log), the kinds
// they may carry, and their zone reach. Feeds declare bounded retention by default;
// unbounded requires a written justification. A cursor that falls behind the horizon
// gets an explicit GAP_KIND event — never a silent hole.
import { z } from "zod";
import { KIND_RE } from "./envelope.js";
import { zoneSchema } from "./zone.js";

export const GAP_KIND = "fabric.gap";

const boundedRetention = z
    .object({ maxAgeMs: z.number().int().positive().optional(), maxEntries: z.number().int().positive().optional() })
    .strict()
    .refine((r) => r.maxAgeMs !== undefined || r.maxEntries !== undefined, {
        message: "bounded retention needs maxAgeMs and/or maxEntries",
    });
const unboundedRetention = z.object({ unbounded: z.string().min(1) }).strict();
export const feedRetentionSchema = z.union([boundedRetention, unboundedRetention]);
export type FeedRetention = z.infer<typeof feedRetentionSchema>;

const channelBase = {
    id: z.string().min(1),
    kinds: z.array(z.string().regex(KIND_RE)).nonempty(),
    zones: z.array(zoneSchema).nonempty(),
};

export const channelSchema = z.discriminatedUnion("class", [
    z.object({ ...channelBase, class: z.literal("stream") }).strict(),
    z.object({ ...channelBase, class: z.literal("feed"), retention: feedRetentionSchema }).strict(),
]);
export type ChannelDeclaration = z.infer<typeof channelSchema>;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm build && pnpm vitest run packages/fabric/dist/__tests__/channel.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fabric/src
git commit -m "feat(fabric): channel declarations — stream vs feed, bounded retention, gap kind

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

### Task 5: Kind registry + public index + full-suite verification

**Files:**
- Create: `packages/fabric/src/kinds.ts`
- Modify: `packages/fabric/src/index.ts` (replace placeholder with re-exports)
- Test: `packages/fabric/src/__tests__/kinds.test.ts`
- Delete: `packages/fabric/src/__tests__/smoke.test.ts` (superseded — index re-export is now exercised by every test)

**Interfaces:**
- Consumes: `KIND_RE` (Task 3).
- Produces:
  - `interface KindDeclaration<T = unknown> { kind: string; owner: string; version: number; payload: z.ZodType<T> }`
  - `function createKindRegistry(): KindRegistry` with `register(declaration): void` (throws `TypeError` on malformed kind or duplicate), `get(kind): KindDeclaration | undefined`, `has(kind): boolean`, `list(): KindDeclaration[]`
  - `src/index.ts` re-exports everything public from all modules.

- [ ] **Step 1: Write the failing test** `packages/fabric/src/__tests__/kinds.test.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKindRegistry } from "../kinds.js";

describe("kind registry", () => {
    const decl = { kind: "chat.token", owner: "@agentgem/console", version: 1, payload: z.object({ text: z.string() }) };

    it("registers and looks up kinds", () => {
        const reg = createKindRegistry();
        reg.register(decl);
        expect(reg.has("chat.token")).toBe(true);
        expect(reg.get("chat.token")?.owner).toBe("@agentgem/console");
        expect(reg.get("nope.kind")).toBeUndefined();
        expect(reg.list().map((d) => d.kind)).toEqual(["chat.token"]);
    });

    it("rejects duplicate registration — kinds are a public API with one owner", () => {
        const reg = createKindRegistry();
        reg.register(decl);
        expect(() => reg.register({ ...decl, owner: "@agentgem/other" })).toThrow(TypeError);
    });

    it("rejects malformed kinds and versions", () => {
        const reg = createKindRegistry();
        expect(() => reg.register({ ...decl, kind: "NoDots" })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, version: 0 })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, version: 1.5 })).toThrow(TypeError);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm build 2>&1 | tail -5`
Expected: FAIL — `../kinds.js` does not exist.

- [ ] **Step 3: Implement** `packages/fabric/src/kinds.ts`

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The kind registry (docs/proposals/message-fabric.md §Envelope). Kinds are a public
// API the moment they cross an install boundary: each has one owning package, a zod
// payload schema, and a version. The registry is what makes deprecation and
// compatibility governable — ad-hoc kind strings are how wire contracts rot.
import type { z } from "zod";
import { KIND_RE } from "./envelope.js";

export interface KindDeclaration<T = unknown> {
    kind: string;
    owner: string;
    version: number;
    payload: z.ZodType<T>;
}

export interface KindRegistry {
    register(declaration: KindDeclaration): void;
    get(kind: string): KindDeclaration | undefined;
    has(kind: string): boolean;
    list(): KindDeclaration[];
}

export function createKindRegistry(): KindRegistry {
    const kinds = new Map<string, KindDeclaration>();
    return {
        register(declaration) {
            if (!KIND_RE.test(declaration.kind)) {
                throw new TypeError(`malformed kind: ${JSON.stringify(declaration.kind)}`);
            }
            if (!Number.isInteger(declaration.version) || declaration.version < 1) {
                throw new TypeError(`kind ${declaration.kind}: version must be a positive integer`);
            }
            if (kinds.has(declaration.kind)) {
                throw new TypeError(`kind already registered: ${declaration.kind}`);
            }
            kinds.set(declaration.kind, declaration);
        },
        get: (kind) => kinds.get(kind),
        has: (kind) => kinds.has(kind),
        list: () => [...kinds.values()],
    };
}
```

- [ ] **Step 4: Replace `packages/fabric/src/index.ts`** and delete the smoke test

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The message-fabric contract package: envelope, addresses, zones, channels, and the
// kind registry. Types, zod schemas, and pure helpers only — the router is increment 2.
// See docs/proposals/message-fabric.md.
export * from "./address.js";
export * from "./channel.js";
export * from "./envelope.js";
export * from "./kinds.js";
export * from "./zone.js";
```

Run: `rm packages/fabric/src/__tests__/smoke.test.ts && rm -rf packages/fabric/dist packages/fabric/tsconfig.tsbuildinfo`
(The dist clean removes the stale compiled smoke test so vitest can't resurrect it.)

- [ ] **Step 5: Full build + full suite**

Run: `pnpm build`
Expected: clean compile.
Run: `pnpm vitest run 2>&1 | tail -4`
Expected: all tests pass, and the file/test counts are LARGER than main's baseline (the four fabric test files are being counted). Record the counts in the report.

- [ ] **Step 6: Commit**

```bash
git add -A packages/fabric
git commit -m "feat(fabric): kind registry and public index

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | ISSUES_FOUND (absorbed) | 1 Critical (v:2 parsed as supported v1) + 5 Warnings — all fixed on-branch |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (DIFF) | 9 issues (3 own + 6 codex), 0 critical gaps — all fixed in commits ae59b1cb + 2249a9c7 |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** outside voice ran on the implementation diff (high reasoning); its Critical — `v: z.number()` lets a v2 envelope parse as *supported* v1, breaking the park-and-surface policy — was the sharpest finding of the review and is fixed with `z.literal(FABRIC_ENVELOPE_VERSION)` plus the loose `envelopeHeaderSchema` park path (which Codex independently endorsed). Its 5 warnings (kind-version dispatch, channel-id grammar, scope-id grammar, signed-crossing assert, registry declaration validation) all fixed.

**CROSS-MODEL:** both models converged on the forward-compat parse path and (second review in a row) on the signed-crossing validator — the earlier deferral was overturned on cross-model signal. No unresolved disagreement.

**VERDICT:** ENG CLEARED — branch ready to ship (full suite 2489 passed / 7 skipped after fixes; fabric tests 40/40).

NO UNRESOLVED DECISIONS
