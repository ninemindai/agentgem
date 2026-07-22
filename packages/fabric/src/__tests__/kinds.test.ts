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

    it("rejects duplicate (kind, version) — kinds are a public API with one owner", () => {
        const reg = createKindRegistry();
        reg.register(decl);
        expect(() => reg.register({ ...decl, owner: "@agentgem/other" })).toThrow(TypeError);
    });

    it("registers payload versions side by side; bare get returns the latest", () => {
        const reg = createKindRegistry();
        reg.register(decl);
        reg.register({ ...decl, version: 2, payload: z.object({ text: z.string(), lang: z.string() }) });
        expect(reg.get("chat.token", 1)?.version).toBe(1); //  feed replay: old entries, original schema
        expect(reg.get("chat.token")?.version).toBe(2); //  new traffic: latest
        expect(reg.has("chat.token", 3)).toBe(false);
        expect(reg.list()).toHaveLength(2);
    });

    it("rejects malformed kinds, versions, owners, and non-zod payloads", () => {
        const reg = createKindRegistry();
        expect(() => reg.register({ ...decl, kind: "NoDots" })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, version: 0 })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, version: 1.5 })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, owner: "   " })).toThrow(TypeError);
        expect(() => reg.register({ ...decl, payload: null as never })).toThrow(TypeError);
    });
});
