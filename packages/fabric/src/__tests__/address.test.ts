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
