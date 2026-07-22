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
