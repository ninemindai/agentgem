# Fabric Router (Increment 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship increment 2 of the message fabric: the in-proc `FabricRouter` (send/publish/ask + in-memory feed channels) living in `@agentgem/fabric`, wired into the app spine, proven by two migrations — the chat turn engine (easy, stream-shaped) and the MCP tool call over `ask()` (hard: capability gating + correlation).

**Architecture:** The router is a plain singleton (the `ChatManager` pattern): constructed in `buildCommonApp`, bound under a `BindingKey` for decorator controllers, swept on an interval from `finalizeCommonApp`. Chat's `liveTurns` engine becomes a fabric **in-memory feed** (`chat/turn-<id>`: buffer + replay-from-0 + wake + close+TTL — semantics identical by construction). `PlayController.mcpCall` keeps its manifest/digest security boundary and routes only the connector invocation through `ask("agentgem://self/mcp/<server>", "mcp.tool.call", …)` to an adapter registered over `callConnectorTool`. **Zero wire/protocol changes: no console/client file is touched.**

**Tech Stack:** TypeScript composite build; `@agentgem/fabric` (zod only — no new deps); `@agentback/core` `BindingKey`/`inject` in `packages/app`.

## Global Constraints

- **PARITY IS THE GATE (CRITICAL, regression rule):** every existing test file listed here must pass **unmodified**: `src/goldmine/__tests__/chatRoutes.test.ts`, `src/goldmine/__tests__/chatCancel.test.ts`, `src/__tests__/acpResume.test.ts`, `src/__tests__/playMcpCall.test.ts`, `packages/console/src/panels/Chat/__tests__/chatStream.test.ts`, `packages/console/src/panels/Play/studioStream.test.ts`. Editing any of them is a plan violation — fix the implementation instead.
- **No console/client changes.** `packages/console/**` must not appear in any diff.
- Behavior invariants carried by the chat engine (from `chatRoutes.ts:197-242`): background-completion guarantee R1 (drain never tied to a socket); checkpoint-before-`done` ordering; generator throw → buffered `failed` event; replay-after-done within TTL (10 min); legacy `?message=` entrance mints its own turn.
- MCP error-code contract unchanged: `not_in_manifest` / `server_not_connected` / `server_config_changed` / `tool_error` / `server_unavailable` / `upstream_error` exactly as today (`packages/model/src/mcpEnvelope.ts` `MCP_ERROR_CODES`).
- Fabric stays dependency-lean: `packages/fabric` gains runtime modules but NO new package deps (zod only). `BindingKey` lives in `packages/app` (fabric must not depend on `@agentback/core`).
- Hot-path rule (proposal §Envelope): no per-publish zod validation; channel declarations are validated at open (`channelSchema`), publish checks only `kind ∈ declared kinds` (Set lookup).
- ULIDs: first (timestamp-region) character capped at `0-7` (48-bit spec cap) — generator stricter than `ULID_RE`.
- License header (2 lines, as in `packages/fabric/src/envelope.ts:1-2`) on every new `src/*.ts`.
- Commits: `feat(fabric): …` / `feat(app): …` / `refactor(app): …`, each ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: ULID generator, FabricRouterError, router core (handle/ask/send)

**Files:**
- Create: `packages/fabric/src/ulid.ts`
- Create: `packages/fabric/src/router.ts`
- Modify: `packages/fabric/src/index.ts` (add `export * from "./ulid.js"; export * from "./router.js";` keeping alphabetical order: address, channel, envelope, kinds, router, ulid, zone)
- Test: `packages/fabric/src/__tests__/ulid.test.ts`, `packages/fabric/src/__tests__/router.test.ts`

**Interfaces:**
- Consumes: `Envelope`, `envelopeSchema`, `FABRIC_ENVELOPE_VERSION`, `FabricErrorKind`, `KIND_RE`, `parseAddress`, `SELF_ROOT`, `createKindRegistry`, `KindDeclaration` from existing fabric modules.
- Produces (Tasks 2-5 rely on):
  - `function ulid(now?: number): string` — 26-char Crockford, first char `0-7`.
  - `class FabricRouterError extends Error { kind: FabricErrorKind; envelopeId?: string }`
  - `class FabricRouter`:
    - `readonly kinds: KindRegistry`
    - `handle(segment: string, handler: (envelope: Envelope) => Promise<unknown>): void` — claims `agentgem://self/<segment>/**`; duplicate segment throws `TypeError`.
    - `ask(to: string, kind: string, payload: unknown, opts: { timeoutMs: number }): Promise<unknown>`
    - `send(to: string, kind: string, payload: unknown): void` — fire-and-forget ask with errors swallowed to a console.error.

- [ ] **Step 1: Write failing tests**

`packages/fabric/src/__tests__/ulid.test.ts`:

```ts
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
```

`packages/fabric/src/__tests__/router.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FabricRouter, FabricRouterError } from "../router.js";

function routerWithEcho(): FabricRouter {
    const router = new FabricRouter();
    router.kinds.register({ kind: "test.echo", owner: "@agentgem/fabric", version: 1, payload: z.unknown() });
    router.kinds.register({ kind: "test.slow", owner: "@agentgem/fabric", version: 1, payload: z.unknown() });
    router.handle("echo", async (env) => ({ echoed: env.payload, kind: env.kind }));
    return router;
}

describe("router ask", () => {
    it("routes to the handler claiming the first sub-path segment and returns its reply", async () => {
        const router = routerWithEcho();
        const reply = await router.ask("agentgem://self/echo/x", "test.echo", { n: 1 }, { timeoutMs: 1000 });
        expect(reply).toEqual({ echoed: { n: 1 }, kind: "test.echo" });
    });

    it("hands the handler a well-formed envelope (v, ulid id, from self)", async () => {
        const router = new FabricRouter();
        router.kinds.register({ kind: "test.echo", owner: "@agentgem/fabric", version: 1, payload: z.unknown() });
        let seen: unknown;
        router.handle("cap", async (env) => { seen = env; return null; });
        await router.ask("agentgem://self/cap", "test.echo", {}, { timeoutMs: 1000 });
        const env = seen as { v: number; id: string; from: string; to: string };
        expect(env.v).toBe(1);
        expect(env.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        expect(env.from).toBe("agentgem://self");
        expect(env.to).toBe("agentgem://self/cap");
    });

    it("times out as a FabricRouterError of kind timeout", async () => {
        const router = routerWithEcho();
        router.handle("slow", () => new Promise(() => { /* never resolves */ }));
        const err = await router.ask("agentgem://self/slow", "test.slow", {}, { timeoutMs: 20 }).catch((e) => e);
        expect(err).toBeInstanceOf(FabricRouterError);
        expect((err as FabricRouterError).kind).toBe("timeout");
    });

    it("no handler → transport error; handler throw → transport error carrying the message", async () => {
        const router = routerWithEcho();
        const none = await router.ask("agentgem://self/nowhere", "test.echo", {}, { timeoutMs: 100 }).catch((e) => e);
        expect((none as FabricRouterError).kind).toBe("transport");
        router.handle("boom", async () => { throw new Error("adapter exploded"); });
        const boom = await router.ask("agentgem://self/boom", "test.echo", {}, { timeoutMs: 100 }).catch((e) => e);
        expect((boom as FabricRouterError).kind).toBe("transport");
        expect((boom as Error).message).toContain("adapter exploded");
    });

    it("rejects unregistered kinds and non-self roots (in-proc only in increment 2)", async () => {
        const router = routerWithEcho();
        await expect(router.ask("agentgem://self/echo", "not.registered", {}, { timeoutMs: 100 })).rejects.toThrow(TypeError);
        await expect(router.ask("agentgem://inst-b/echo", "test.echo", {}, { timeoutMs: 100 })).rejects.toThrow(TypeError);
    });

    it("duplicate handle segment throws", () => {
        const router = routerWithEcho();
        expect(() => router.handle("echo", async () => null)).toThrow(TypeError);
    });
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm exec tsc -b 2>&1 | tail -5` → FAIL, TS2307 for `../ulid.js` / `../router.js`.

- [ ] **Step 3: Implement** `packages/fabric/src/ulid.ts`:

```ts
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
```

`packages/fabric/src/router.ts` (Task 2 extends this same file with feeds — Step 3 here creates it with the core only):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The in-proc fabric router (docs/proposals/message-fabric.md §The router,
// increment 2). One instance per app spine, constructed in buildCommonApp and
// swept from finalizeCommonApp (the ChatManager pattern). Increment 2 is
// in-proc only: every address resolves under the `self` root, no zone is ever
// crossed, so the gate machinery stays dormant — by design, not omission.
import { FABRIC_ENVELOPE_VERSION, type Envelope, type FabricErrorKind } from "./envelope.js";
import { createKindRegistry, type KindRegistry } from "./kinds.js";
import { parseAddress, SELF_ROOT } from "./address.js";
import { ulid } from "./ulid.js";

export class FabricRouterError extends Error {
    readonly kind: FabricErrorKind;
    readonly envelopeId?: string;
    constructor(kind: FabricErrorKind, message: string, envelopeId?: string) {
        super(message);
        this.name = "FabricRouterError";
        this.kind = kind;
        this.envelopeId = envelopeId;
    }
}

type AskHandler = (envelope: Envelope) => Promise<unknown>;

export class FabricRouter {
    readonly kinds: KindRegistry = createKindRegistry();
    private readonly handlers = new Map<string, AskHandler>();

    /** Claim agentgem://self/<segment>/** for a handler. */
    handle(segment: string, handler: AskHandler): void {
        if (this.handlers.has(segment)) throw new TypeError(`fabric segment already handled: ${segment}`);
        this.handlers.set(segment, handler);
    }

    private mint(to: string, kind: string, payload: unknown): Envelope {
        if (!this.kinds.has(kind)) throw new TypeError(`unregistered kind: ${kind}`);
        const parsed = parseAddress(to);
        if (parsed.root !== SELF_ROOT) {
            throw new TypeError(`increment-2 router is in-proc only; non-self root: ${to}`);
        }
        return {
            v: FABRIC_ENVELOPE_VERSION,
            id: ulid(),
            kind,
            from: `agentgem://${SELF_ROOT}`,
            to,
            channel: "fabric/ask",
            payload,
        };
    }

    async ask(to: string, kind: string, payload: unknown, opts: { timeoutMs: number }): Promise<unknown> {
        const envelope = this.mint(to, kind, payload);
        const segment = parseAddress(to).path[0];
        const handler = segment !== undefined ? this.handlers.get(segment) : undefined;
        if (!handler) throw new FabricRouterError("transport", `no endpoint for ${to}`, envelope.id);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new FabricRouterError("timeout", `ask timed out after ${opts.timeoutMs}ms: ${to}`, envelope.id)), opts.timeoutMs);
            (timer as { unref?: () => void }).unref?.();
        });
        try {
            return await Promise.race([
                handler(envelope).catch((e) => {
                    if (e instanceof FabricRouterError) throw e;
                    throw new FabricRouterError("transport", (e as Error).message, envelope.id);
                }),
                timeout,
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    /** Fire-and-forget ask; failures are surfaced to the log, never thrown. */
    send(to: string, kind: string, payload: unknown): void {
        void this.ask(to, kind, payload, { timeoutMs: 30_000 }).catch((e) => {
            console.error(`fabric send failed (${to}, ${kind}):`, (e as Error).message);
        });
    }
}
```

Update `packages/fabric/src/index.ts` to:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The message-fabric package: the wire contract (envelope, addresses, zones,
// channels, kind registry) and the in-proc router (increment 2).
// See docs/proposals/message-fabric.md.
export * from "./address.js";
export * from "./channel.js";
export * from "./envelope.js";
export * from "./kinds.js";
export * from "./router.js";
export * from "./ulid.js";
export * from "./zone.js";
```

- [ ] **Step 4: Verify green** — `pnpm exec tsc -b && pnpm vitest run packages/fabric/dist/__tests__` → all pass (existing 40 + new).

- [ ] **Step 5: Commit** — `git add packages/fabric/src && git commit -m "feat(fabric): ulid generator and in-proc router core (handle/ask/send)"` + trailer.

### Task 2: In-memory feed channels on the router

**Files:**
- Modify: `packages/fabric/src/router.ts` (extend `FabricRouter`)
- Test: `packages/fabric/src/__tests__/routerFeeds.test.ts`

**Interfaces:**
- Consumes: `channelSchema`, `ChannelDeclaration` from `./channel.js`.
- Produces (Task 4 relies on — exact signatures):
  - `openFeed(declaration: { id: string; kinds: string[]; maxAgeMs: number }): void` — validates via `channelSchema` (`class: "feed"`, `zones: ["in-proc"]`, `retention: { maxAgeMs }`); duplicate id throws `TypeError`; kinds must be registered.
  - `publish(channelId: string, kind: string, payload: unknown): void` — throws `TypeError` on unknown channel, undeclared kind, or after `closeFeed`.
  - `readFeed(channelId: string, from: number): { envelopes: Envelope[]; done: boolean }` — replay from index; unknown/expired channel → `{ envelopes: [], done: true }`.
  - `waitFeed(channelId: string, after: number): Promise<void>` — resolves when `events.length > after` OR the feed closes; resolves immediately for unknown/expired channels.
  - `closeFeed(channelId: string): void` — marks done, wakes waiters; the buffer stays readable until swept.
  - `sweep(now?: number): void` — drops feeds closed longer than their `maxAgeMs` ago.

- [ ] **Step 1: Write failing test** `packages/fabric/src/__tests__/routerFeeds.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FabricRouter } from "../router.js";

function feedRouter(): FabricRouter {
    const router = new FabricRouter();
    router.kinds.register({ kind: "chat.delta", owner: "@agentgem/run", version: 1, payload: z.unknown() });
    router.kinds.register({ kind: "chat.done", owner: "@agentgem/run", version: 1, payload: z.unknown() });
    router.openFeed({ id: "chat/turn-1", kinds: ["chat.delta", "chat.done"], maxAgeMs: 60_000 });
    return router;
}

describe("in-memory feed channels", () => {
    it("replays from index 0 and reports done", () => {
        const router = feedRouter();
        router.publish("chat/turn-1", "chat.delta", { text: "a" });
        router.publish("chat/turn-1", "chat.delta", { text: "b" });
        const r1 = router.readFeed("chat/turn-1", 0);
        expect(r1.envelopes.map((e) => (e.payload as { text: string }).text)).toEqual(["a", "b"]);
        expect(r1.done).toBe(false);
        router.closeFeed("chat/turn-1");
        expect(router.readFeed("chat/turn-1", 2)).toEqual({ envelopes: [], done: true });
    });

    it("waitFeed resolves on new events and on close", async () => {
        const router = feedRouter();
        const woke = router.waitFeed("chat/turn-1", 0);
        router.publish("chat/turn-1", "chat.delta", { text: "x" });
        await woke; //  event arrival wakes
        const wokeOnClose = router.waitFeed("chat/turn-1", 1);
        router.closeFeed("chat/turn-1");
        await wokeOnClose; //  close wakes
    });

    it("late subscriber after close still replays until swept; sweep removes it after maxAgeMs", () => {
        const router = feedRouter();
        router.publish("chat/turn-1", "chat.delta", { text: "kept" });
        router.closeFeed("chat/turn-1");
        expect(router.readFeed("chat/turn-1", 0).envelopes).toHaveLength(1); //  replay-after-done
        router.sweep(Date.now() + 61_000);
        expect(router.readFeed("chat/turn-1", 0)).toEqual({ envelopes: [], done: true }); //  gone
    });

    it("enforces declarations: unknown channel, undeclared kind, publish-after-close, dup open", () => {
        const router = feedRouter();
        expect(() => router.publish("nope", "chat.delta", {})).toThrow(TypeError);
        expect(() => router.publish("chat/turn-1", "chat.tool", {})).toThrow(TypeError); //  undeclared on channel
        expect(() => router.openFeed({ id: "chat/turn-1", kinds: ["chat.delta"], maxAgeMs: 1 })).toThrow(TypeError);
        router.closeFeed("chat/turn-1");
        expect(() => router.publish("chat/turn-1", "chat.delta", {})).toThrow(TypeError);
    });

    it("open validates the channel contract (grammar + registered kinds)", () => {
        const router = feedRouter();
        expect(() => router.openFeed({ id: "Bad Id", kinds: ["chat.delta"], maxAgeMs: 1000 })).toThrow();
        expect(() => router.openFeed({ id: "ok/id", kinds: ["never.registered"], maxAgeMs: 1000 })).toThrow(TypeError);
    });
});
```

- [ ] **Step 2: Verify RED** — `pnpm exec tsc -b 2>&1 | tail -5` → missing methods (TS2339).

- [ ] **Step 3: Implement** — extend `FabricRouter` in `router.ts` (add import `{ channelSchema } from "./channel.js";`):

```ts
interface LiveFeed {
    kinds: Set<string>;
    envelopes: Envelope[];
    done: boolean;
    closedAt?: number;
    maxAgeMs: number;
    wake: Set<() => void>;
}
```

and methods on the class:

```ts
    private readonly feeds = new Map<string, LiveFeed>();

    /** Open an in-memory feed (process-scoped; durable feeds arrive in increment 5). */
    openFeed(declaration: { id: string; kinds: string[]; maxAgeMs: number }): void {
        if (this.feeds.has(declaration.id)) throw new TypeError(`feed already open: ${declaration.id}`);
        //  Boundary validation (hot-path rule): the declaration is checked ONCE here,
        //  per-publish work is Set lookups only.
        channelSchema.parse({
            id: declaration.id,
            class: "feed",
            kinds: declaration.kinds,
            zones: ["in-proc"],
            retention: { maxAgeMs: declaration.maxAgeMs },
        });
        for (const kind of declaration.kinds) {
            if (!this.kinds.has(kind)) throw new TypeError(`feed ${declaration.id}: unregistered kind ${kind}`);
        }
        this.feeds.set(declaration.id, {
            kinds: new Set(declaration.kinds),
            envelopes: [],
            done: false,
            maxAgeMs: declaration.maxAgeMs,
            wake: new Set(),
        });
    }

    publish(channelId: string, kind: string, payload: unknown): void {
        const feed = this.feeds.get(channelId);
        if (!feed) throw new TypeError(`unknown feed: ${channelId}`);
        if (feed.done) throw new TypeError(`feed closed: ${channelId}`);
        if (!feed.kinds.has(kind)) throw new TypeError(`kind ${kind} not declared on ${channelId}`);
        feed.envelopes.push({
            v: FABRIC_ENVELOPE_VERSION,
            id: ulid(),
            kind,
            from: `agentgem://${SELF_ROOT}`,
            to: { scope: "self" },
            channel: channelId,
            payload,
        });
        this.bump(feed);
    }

    readFeed(channelId: string, from: number): { envelopes: Envelope[]; done: boolean } {
        const feed = this.feeds.get(channelId);
        if (!feed) return { envelopes: [], done: true };
        return { envelopes: feed.envelopes.slice(from), done: feed.done };
    }

    waitFeed(channelId: string, after: number): Promise<void> {
        const feed = this.feeds.get(channelId);
        if (!feed || feed.done || feed.envelopes.length > after) return Promise.resolve();
        return new Promise<void>((resolve) => feed.wake.add(resolve));
    }

    closeFeed(channelId: string): void {
        const feed = this.feeds.get(channelId);
        if (!feed || feed.done) return;
        feed.done = true;
        feed.closedAt = Date.now();
        this.bump(feed);
    }

    /** Drop feeds whose close is older than their retention. Called on an interval by the host. */
    sweep(now: number = Date.now()): void {
        for (const [id, feed] of this.feeds) {
            if (feed.done && feed.closedAt !== undefined && now - feed.closedAt > feed.maxAgeMs) this.feeds.delete(id);
        }
    }

    private bump(feed: LiveFeed): void {
        const waiters = [...feed.wake];
        feed.wake.clear();
        for (const wake of waiters) wake();
    }
```

- [ ] **Step 4: Verify green** — `pnpm exec tsc -b && pnpm vitest run packages/fabric/dist/__tests__`.
- [ ] **Step 5: Commit** — `feat(fabric): in-memory feed channels (open/publish/read/wait/close/sweep)` + trailer.

### Task 3: App-spine wiring — binding, kind registrations, MCP adapter

**Files:**
- Create: `packages/app/src/fabric.binding.ts`
- Modify: `packages/app/package.json` (add `"@agentgem/fabric": "workspace:*"` alphabetically between `@agentgem/distribute` and `@agentgem/insight`)
- Modify: `packages/app/tsconfig.json` (add `{ "path": "../fabric" }` to `references`)
- Modify: `packages/app/src/appCommon.ts`
- Test: `packages/app/src/__tests__/fabricWiring.test.ts`

**Interfaces:**
- Consumes: `FabricRouter`, `FabricRouterError` from `@agentgem/fabric`; `callConnectorTool`, `ConnectorError` from `@agentgem/play` (import exactly as `play.controller.ts` imports them today — check its import line and mirror it).
- Produces:
  - `FABRIC_ROUTER = BindingKey.create<FabricRouter>("agentgem.fabric.router")` in `fabric.binding.ts`.
  - `buildCommonApp` constructs the router, registers kinds `chat.phase|chat.delta|chat.tool|chat.done|chat.failed` (owner `@agentgem/run`, v1, `z.unknown()` payloads — the ChatEvent union is validated by its own TS types; wire-tightening is deferred) and `mcp.tool.call` (owner `@agentgem/play`, v1), registers the MCP adapter, and binds `FABRIC_ROUTER`.
  - `finalizeCommonApp` adds `setInterval(() => router.sweep(), 60_000).unref()` beside the ChatManager sweep and passes `router` into `registerChatRoutes` deps (Task 4 consumes; until Task 4 lands, passing it is inert).

- [ ] **Step 1: Write failing test** `packages/app/src/__tests__/fabricWiring.test.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { FabricRouter } from "@agentgem/fabric";
import { registerMcpAdapter } from "../fabric.binding.js";

describe("fabric app wiring", () => {
    it("registers the standard kinds and the mcp adapter segment", () => {
        const router = new FabricRouter();
        registerMcpAdapter(router, {
            callConnectorTool: async () => ({ content: [{ type: "text", text: "hi" }] }),
        });
        for (const kind of ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed", "mcp.tool.call"]) {
            expect(router.kinds.has(kind), kind).toBe(true);
        }
    });

    it("adapter answers ask with the connector result; ConnectorError becomes an error-shaped reply (never a throw)", async () => {
        const router = new FabricRouter();
        const calls: unknown[] = [];
        registerMcpAdapter(router, {
            callConnectorTool: async (server, tool, args) => {
                calls.push([server, tool, args]);
                return { content: [{ type: "text", text: "ok" }], structuredContent: { fine: true } };
            },
        });
        const reply = await router.ask("agentgem://self/mcp/github", "mcp.tool.call", { tool: "listCommits", input: { n: 1 } }, { timeoutMs: 1000 });
        expect(calls).toEqual([["github", "listCommits", { n: 1 }]]);
        expect(reply).toEqual({ ok: true, result: { content: [{ type: "text", text: "ok" }], structuredContent: { fine: true } } });
    });

    it("adapter converts a ConnectorError-like failure into { ok:false, code, message }", async () => {
        const router = new FabricRouter();
        class FakeConnectorError extends Error { code = "tool_error"; }
        registerMcpAdapter(router, {
            callConnectorTool: async () => { throw new FakeConnectorError("boom"); },
            isConnectorError: (e): e is Error & { code: string } => e instanceof FakeConnectorError,
        });
        const reply = await router.ask("agentgem://self/mcp/github", "mcp.tool.call", { tool: "x", input: {} }, { timeoutMs: 1000 });
        expect(reply).toEqual({ ok: false, code: "tool_error", message: "boom" });
    });
});
```

- [ ] **Step 2: Verify RED** — `pnpm exec tsc -b 2>&1 | tail -5` → TS2307 `../fabric.binding.js`.

- [ ] **Step 3: Implement** `packages/app/src/fabric.binding.ts`:

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Fabric router wiring for the app spine: the DI key, the standard in-app kind
// registrations, and the MCP adapter (docs/proposals/message-fabric.md §Parties).
// The adapter owns NO authorization: the manifest/digest security boundary stays
// in PlayController.mcpCall — by the proposal's three-layer split, the fabric
// authorizes the message, the handler owns the business outcome.
import { BindingKey } from "@agentback/core";
import { FabricRouter, parseAddress } from "@agentgem/fabric";
import { z } from "zod";

export const FABRIC_ROUTER = BindingKey.create<FabricRouter>("agentgem.fabric.router");

export const MCP_ASK_TIMEOUT_MS = 120_000; //  generous backstop: the SDK's own timeout fires first

export interface McpAdapterDeps {
    callConnectorTool(server: string, tool: string, input: unknown): Promise<{ content: unknown[]; structuredContent?: unknown }>;
    isConnectorError?(e: unknown): e is Error & { code: string };
}

export type McpAskReply =
    | { ok: true; result: { content: unknown[]; structuredContent?: unknown } }
    | { ok: false; code: string; message: string };

export function registerMcpAdapter(router: FabricRouter, deps: McpAdapterDeps): void {
    for (const kind of ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed"]) {
        router.kinds.register({ kind, owner: "@agentgem/run", version: 1, payload: z.unknown() });
    }
    router.kinds.register({ kind: "mcp.tool.call", owner: "@agentgem/play", version: 1, payload: z.unknown() });
    router.handle("mcp", async (envelope): Promise<McpAskReply> => {
        const server = parseAddress(envelope.to as string).path[1];
        const { tool, input } = envelope.payload as { tool: string; input: unknown };
        if (!server || !tool) return { ok: false, code: "bad_request", message: "mcp ask needs a server sub-path and a tool" };
        try {
            const result = await deps.callConnectorTool(server, tool, input);
            return { ok: true, result };
        } catch (e) {
            //  ConnectorError is an APPLICATION error — it rides the reply payload, never a
            //  fabric error (proposal §Error handling). Anything else rethrows into the
            //  fabric transport error and the caller maps it to upstream_error.
            if (deps.isConnectorError?.(e)) return { ok: false, code: e.code, message: e.message };
            throw e;
        }
    });
}
```

Then wire `appCommon.ts` (minimal, surgical — find the exact anchors):

1. Imports: `import { FabricRouter } from "@agentgem/fabric";` and `import { FABRIC_ROUTER, registerMcpAdapter } from "./fabric.binding.js";` plus `import { callConnectorTool, ConnectorError } from "@agentgem/play";` (mirror the exact specifier `play.controller.ts` uses for these symbols).
2. In `buildCommonApp`, right after `app.component(GemCoreComponent)`:

```ts
    //  The fabric router (message-fabric increment 2): one in-proc instance per spine.
    const fabricRouter = new FabricRouter();
    registerMcpAdapter(fabricRouter, {
        callConnectorTool,
        isConnectorError: (e): e is Error & { code: string } => e instanceof ConnectorError,
    });
    app.bind(FABRIC_ROUTER).to(fabricRouter);
```

3. In `finalizeCommonApp`, beside the `chatManager.sweepIdle()` interval (`appCommon.ts:325`), retrieve the router and start its sweep. For retrieval, FIRST check how `appCommon.ts`/controllers already resolve bindings from `app` (mirror that exact API — `await app.get(FABRIC_ROUTER)` in agentback style); if `finalizeCommonApp` cannot cleanly resolve bindings, instead thread the instance: have `buildCommonApp` keep `fabricRouter` on its existing return value (extend the returned object with `fabricRouter`) and let each entry pass it through — pick whichever matches the file's current conventions with the smallest diff.

```ts
    setInterval(() => fabricRouter.sweep(), 60_000).unref();
```

Do NOT add `router:` to the `registerChatRoutes(...)` deps object in this task — the deps type gains that optional field only in Task 4, and adding the property before the type exists is a compile error. Task 4 Step 4 makes that one-line edit.

- [ ] **Step 4: Verify** — `pnpm exec tsc -b && pnpm vitest run packages/app/dist/__tests__/fabricWiring.test.js` green, then `pnpm vitest run` (root) — full suite green (wiring must not disturb anything).

- [ ] **Step 5: Commit** — `feat(app): fabric router wiring — binding, standard kinds, mcp adapter` + trailer. Files: `packages/app/src/fabric.binding.ts`, `packages/app/src/__tests__/fabricWiring.test.ts`, `packages/app/package.json`, `packages/app/tsconfig.json`, `packages/app/src/appCommon.ts`, `pnpm-lock.yaml`.

### Task 4: Chat turn engine on fabric feeds (parity migration)

**Files:**
- Modify: `packages/app/src/goldmine/chatRoutes.ts` ONLY.

**Interfaces:**
- Consumes: `FabricRouter` (deps field), `openFeed`/`publish`/`readFeed`/`waitFeed`/`closeFeed` exactly as Task 2 defined.
- Produces: identical HTTP behavior; `ChatRouteDeps` gains `router: FabricRouter`.

The migration replaces the private `LiveTurn` machinery with router feeds. Turn channel id: `chat/turn-${turnId}` where `turnId = randomUUID()` (lowercase hex + dashes — valid channel-id segments). Event kind mapping: `ChatEvent.type` → `chat.${ev.type}`; the payload is the whole `ChatEvent` so the stream handler forwards `env.payload` byte-identically to today.

- [ ] **Step 1: The failing gate is the EXISTING suite** — no new test file. Before changing code run `pnpm vitest run dist/goldmine/__tests__/chatRoutes.test.js dist/goldmine/__tests__/chatCancel.test.js dist/__tests__/acpResume.test.js` → green (baseline).

- [ ] **Step 2: Rewrite the turn engine block** (`chatRoutes.ts:208-242` today). Add to `ChatRouteDeps` interface: `router?: FabricRouter;` (VALUE import — `import { FabricRouter } from "@agentgem/fabric";` — Step 5's fallback constructs it). Keep the big explanatory comment block, amend its first line to note the buffer now lives in the fabric router. Replace `interface LiveTurn…`/`const liveTurns…`/`const TURN_TTL_MS…`/`startTurn` with:

```ts
  //  Turn buffers are fabric in-memory feeds (message-fabric increment 2): replay-from-0,
  //  wake-on-publish, close + TTL sweep — the same contract LiveTurn hand-rolled, now shared.
  const TURN_TTL_MS = 10 * 60_000; // the buffer survives briefly past done for a late re-attach
  const CHAT_KINDS = ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed"];
  const turnChannel = (turnId: string) => `chat/turn-${turnId}`;
  const turnChats = new Map<string, string>(); // turnId -> chatId (ownership check on attach)

  const startTurn = (chatId: string, message: string): string => {
    const turnId = randomUUID();
    const channel = turnChannel(turnId);
    deps.router.openFeed({ id: channel, kinds: CHAT_KINDS, maxAgeMs: TURN_TTL_MS });
    turnChats.set(turnId, chatId);
    void (async () => {
      const miniapp = chatMiniapps.get(chatId);
      try {
        for await (const ev of deps.manager.sendMessage(chatId, message)) {
          // Checkpoint BEFORE the done event becomes visible to any attached stream (2026-07-20
          // eng review, issue 6): the client may auto-fire a queued next turn the moment it sees
          // `done`, and that turn's edits must not race this turn's durability commit. A
          // checkpoint failure is logged and swallowed — it must never turn a successful turn
          // into a failed one, and `done` is buffered regardless.
          if (ev.type === "done" && miniapp && deps.checkpointMiniapp) {
            try { await deps.checkpointMiniapp(miniapp); }
            catch (e) { console.error(`checkpoint failed for miniapp ${miniapp}:`, (e as Error).message); }
          }
          deps.router.publish(channel, `chat.${ev.type}`, ev);
        }
      } catch (e) {
        // A generator throw becomes a buffered `failed` event — attached streams (native or AG-UI,
        // whose mapper routes `failed` to RUN_ERROR) forward it like any other frame.
        deps.router.publish(channel, "chat.failed", { type: "failed", error: (e as Error).message });
      }
      deps.router.closeFeed(channel);
      const t = setTimeout(() => turnChats.delete(turnId), TURN_TTL_MS);
      (t as { unref?: () => void }).unref?.();
    })();
    return turnId;
  };
```

(Note: inside the drain, `deps.router` reads must use the resolved `router` local
from Step 5's fallback — i.e. write `router.openFeed/publish/closeFeed` throughout,
not `deps.router.…`; the blocks above show the calls' shape.)

- [ ] **Step 3: Rewrite the stream attach loop** (`chatRoutes.ts:264-293` today). The 404 check becomes `turnChats`-based; the replay loop reads the feed:

```ts
    const turnId = turnIdParam || startTurn(chatId, String(req.query.message ?? ""));
    const channel = `chat/turn-${turnId}`;
    const owner = turnChats.get(turnId);
    if (owner === undefined || owner !== chatId) { res.status(404).json({ error: "unknown turn" }); return; }
```

(`turnChats` is the single source of turn existence — deleted on the same TTL the
old `liveTurns.delete` used, so the 404 window matches today; change the Step-2
cleanup line to `setTimeout(() => turnChats.delete(turnId), TURN_TTL_MS).unref?.()`
**scheduled inside the drain's completion, right after `closeFeed`** — mirroring the
old code's delete-after-done+TTL — NOT at startTurn time.)

```ts
```

(unchanged headers + forwarder setup, then:)

```ts
    let i = 0;
    for (;;) {
      const { envelopes, done } = deps.router.readFeed(channel, i);
      for (const env of envelopes) forward(env.payload as ChatEvent);
      i += envelopes.length;
      if (done && envelopes.length === 0) break;
      if (!done) await deps.router.waitFeed(channel, i);
    }
    try { res.end(); } catch { /* client already disconnected */ }
```

CAREFUL with the loop-exit condition: it must forward everything buffered, then exit when the feed is done AND fully drained — trace it against the replay-after-done test before running.

- [ ] **Step 4: Update `appCommon.ts`** — add `router: fabricRouter,` to the `registerChatRoutes` deps object (the line Task 3 held back).

- [ ] **Step 5: Update test factories in place?** NO — the parity gate forbids editing the listed test files. If `chatRoutes.test.ts` constructs `registerChatRoutes` deps directly, it now fails to compile (missing `router`). THAT test file is on the untouchable list — so instead give the deps field a safe default: make it `router?: FabricRouter` and default inside `registerChatRoutes` to `new FabricRouter()` with the chat kinds registered when absent:

```ts
  const fallback = () => {
    const r = new FabricRouter();
    for (const kind of ["chat.phase", "chat.delta", "chat.tool", "chat.done", "chat.failed"]) {
      r.kinds.register({ kind, owner: "@agentgem/run", version: 1, payload: z.unknown() });
    }
    return r;
  };
  const router = deps.router ?? fallback();
```

(then use `router.` not `deps.router.` throughout; `z` may already be imported — check; if not, import it). This keeps every existing caller/test source-compatible.

- [ ] **Step 6: Verify the parity gate** — `pnpm build`, then:
`pnpm vitest run dist/goldmine/__tests__/chatRoutes.test.js dist/goldmine/__tests__/chatCancel.test.js dist/__tests__/acpResume.test.js` → **every test green, zero edits to those files** (`git diff --name-only` must not contain any `__tests__` path). Then the full root suite green.

- [ ] **Step 7: Commit** — `refactor(app): chat turn engine rides fabric feed channels (parity-gated)` + trailer.

### Task 5: MCP tool call over ask()

**Files:**
- Modify: `packages/app/src/play.controller.ts` (the `mcpCall` method + constructor + imports ONLY)
- Test: `packages/app/src/__tests__/fabricMcpAsk.test.ts` (new)

**Interfaces:**
- Consumes: `FABRIC_ROUTER`, `MCP_ASK_TIMEOUT_MS`, `McpAskReply` from `../fabric.binding.js`; `FabricRouterError` from `@agentgem/fabric`.
- Produces: identical `/api/play/mcp/call` behavior; the connector invocation flows through the router.

- [ ] **Step 1: Write the new failing test** `packages/app/src/__tests__/fabricMcpAsk.test.ts` — tests the CONTROLLER-LEVEL mapping using a router with a stubbed adapter (mirror how `playMcpCall.test.ts` builds the controller/app — read that file's setup first and reuse its harness pattern; do not modify it):

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
//  Increment-2 proof: the MCP tool call rides router.ask() — fabric errors map back
//  onto the existing MCP error-code contract, application errors ride the reply.
import { describe, expect, it } from "vitest";
import { FabricRouterError } from "@agentgem/fabric";
import { mapAskFailure } from "../fabric.binding.js";

describe("ask-failure → MCP error-code mapping", () => {
    it("fabric timeout → server_unavailable (matches callConnectorTool's own timeout contract)", () => {
        expect(mapAskFailure(new FabricRouterError("timeout", "t"))).toEqual({ code: "server_unavailable", message: "t" });
    });
    it("fabric transport → upstream_error", () => {
        expect(mapAskFailure(new FabricRouterError("transport", "x"))).toEqual({ code: "upstream_error", message: "x" });
    });
    it("non-fabric throw → upstream_error", () => {
        expect(mapAskFailure(new Error("y"))).toEqual({ code: "upstream_error", message: "y" });
    });
});
```

Plus one integration case appended to this same file exercising the wired route if the harness from `playMcpCall.test.ts` is cheaply reusable (build app → save miniapp with a manifest → stub connector → POST `/api/play/mcp/call` → assert `ok:true` result flows through the router path — assert via a `router.kinds.has("mcp.tool.call")` sanity + response shape). If the harness is NOT cheaply reusable, skip the integration case here — `playMcpCall.test.ts` (untouchable, green) already covers the route end-to-end through the new path.

- [ ] **Step 2: Verify RED** — `mapAskFailure` doesn't exist yet (TS2305).

- [ ] **Step 3: Implement.** In `fabric.binding.ts` add:

```ts
export function mapAskFailure(e: unknown): { code: string; message: string } {
    if (e instanceof FabricRouterError && e.kind === "timeout") return { code: "server_unavailable", message: e.message };
    return { code: "upstream_error", message: (e as Error).message };
}
```

(import `FabricRouterError` from `@agentgem/fabric` there.)

In `play.controller.ts`:
1. Constructor gains `@inject(FABRIC_ROUTER, { optional: true }) private fabricRouter?: FabricRouter` — mirror `InsightsController`'s exact decorator style (`packages/app/src/insights.controller.ts:34-41`); import `inject` the way that file does.
2. Replace the `try { const result = await callConnectorTool(...) } catch` block (`play.controller.ts:240-248`) with:

```ts
    try {
      const raw = this.fabricRouter
        ? await this.fabricRouter.ask(`agentgem://self/mcp/${server}`, "mcp.tool.call", { tool, input: args }, { timeoutMs: MCP_ASK_TIMEOUT_MS })
        : undefined;
      if (raw === undefined) {
        //  No router bound (bare-controller embeddings): the direct path keeps behavior identical.
        const result = await callConnectorTool(server, tool, args);
        return { ok: true, payload: derivePayload(result as Parameters<typeof derivePayload>[0]), content: result.content };
      }
      const reply = raw as McpAskReply;
      if (!reply.ok) return { ok: false, error: { code: reply.code as never, message: reply.message } };
      return { ok: true, payload: derivePayload(reply.result as Parameters<typeof derivePayload>[0]), content: reply.result.content };
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false, error: { code: e.code, message: e.message } };
      const mapped = mapAskFailure(e);
      return { ok: false, error: { code: mapped.code as never, message: mapped.message } };
    }
```

The manifest check, digest check, and 404 behavior above this block DO NOT MOVE — the security boundary stays in the controller (authorization layer 2: which kinds a sender may invoke; the fabric authorizes the message, the handler owns nothing security-relevant).

- [ ] **Step 4: Verify the parity gate** — `pnpm build`, then `pnpm vitest run dist/__tests__/playMcpCall.test.js dist/__tests__/playMcpRoute.test.js packages/app/dist/__tests__/fabricMcpAsk.test.js` all green with zero edits to existing test files; then full root suite green.

- [ ] **Step 5: Commit** — `feat(app): mcp tool call rides fabric ask() — security boundary stays in PlayController` + trailer.
