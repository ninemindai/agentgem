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
