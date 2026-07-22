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
