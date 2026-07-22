// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Hierarchical fabric addresses (docs/proposals/message-fabric.md §Addresses):
// agentgem://<root>[/<segment>]*. Roots are federated identities holding keys;
// sub-paths are routing AND audit identity, never federated identity.
import { z } from "zod";

export const ADDRESS_SCHEME = "agentgem://";
export const SELF_ROOT = "self";

// Roots and segments: lowercase alphanumerics with interior dashes (inst-a1b2,
// org-ninemind, mcp, repo-pulse). No uppercase, no empty segments, no trailing slash.
const SEGMENT = "[a-z0-9]+(-[a-z0-9]+)*";
const ADDRESS_RE = new RegExp(`^agentgem://${SEGMENT}(/${SEGMENT})*$`);

export const addressSchema = z.string().regex(ADDRESS_RE, "not an agentgem:// address");

export interface ParsedAddress {
    root: string;
    path: string[];
}

export function parseAddress(address: string): ParsedAddress {
    if (!ADDRESS_RE.test(address)) throw new TypeError(`malformed fabric address: ${JSON.stringify(address)}`);
    const [root, ...path] = address.slice(ADDRESS_SCHEME.length).split("/");
    return { root, path };
}

export function formatAddress(parsed: ParsedAddress): string {
    return ADDRESS_SCHEME + [parsed.root, ...parsed.path].join("/");
}

// `self` is a router-local alias resolved to the real root id at send time. A
// zone-crossing envelope still containing `self` is a contract violation — signatures
// must bind absolute addresses (see envelope.ts assertNoSelfAcrossZones).
export function isSelfAddress(address: string): boolean {
    return parseAddress(address).root === SELF_ROOT;
}
