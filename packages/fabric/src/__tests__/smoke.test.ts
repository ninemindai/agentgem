// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { FABRIC_ENVELOPE_VERSION } from "../index.js";

describe("@agentgem/fabric package wiring", () => {
    it("compiles and is discovered by the root vitest config", () => {
        expect(FABRIC_ENVELOPE_VERSION).toBe(1);
    });
});
