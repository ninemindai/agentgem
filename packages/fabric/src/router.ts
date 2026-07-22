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
