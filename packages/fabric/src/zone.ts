// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Trust zones (docs/proposals/message-fabric.md §Trust zones). Zones are trust
// boundaries, not network distance — "sealed" is local-but-untrusted code (miniapps,
// MCP servers) living inside the machine behind a capability bridge.
import { z } from "zod";

export const ZONES = ["in-proc", "sealed", "machine", "owned-devices", "federated"] as const;
export type Zone = (typeof ZONES)[number];
export const zoneSchema = z.enum(ZONES);

// A crossing is any traffic between two distinct zones. Concentric containment does
// not exempt a pair: sealed→machine crosses (that's the miniapp bridge), and every
// crossing is where the mailbox's gate machinery attaches (normative in
// docs/proposals/actor-inbox-outbox.md — not here).
export function isZoneCrossing(a: Zone, b: Zone): boolean {
    return a !== b;
}
