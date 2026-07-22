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
