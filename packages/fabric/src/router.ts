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
import { channelSchema } from "./channel.js";
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

interface LiveFeed {
    kinds: Set<string>;
    envelopes: Envelope[];
    done: boolean;
    closedAt?: number;
    maxAgeMs: number;
    wake: Set<() => void>;
}

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
                Promise.resolve().then(() => handler(envelope)).catch((e) => {
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
}
