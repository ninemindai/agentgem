// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/nostr/linkLocal.ts — `agentgem nostr link`: the local fast-path for linking a Nostr key to
// your account. Because the AgentGem host holds BOTH the account-bound session (from `agentgem bind`)
// AND the local Nostr secret, it can complete the link without a browser NIP-07 extension — it signs
// the server's challenge with the local nsec directly. Same server endpoints as the web path; the
// only difference is who signs (the local key, not a browser extension).
import { loadOrCreateNostrIdentity, type NostrIdentity } from "@agentgem/model";
import { readSession, bindConfig, type LocalSession } from "@agentgem/app/bind/bindCore";

export interface LinkLocalDeps {
  fetchImpl?: typeof fetch;
  base?: string;
  session?: LocalSession | null; // undefined → read the on-disk bind session
  identity?: NostrIdentity;      // undefined → load/create ~/.agentgem/nostr-identity.json
  now?: () => number;
}

export type LinkLocalResult =
  | { ok: true; npub: string; connected: string[] }
  | { ok: false; reason: "signed-out" | "no-base" | "challenge-failed" | "link-failed"; detail?: string };

/**
 * Drive the two account endpoints with the local session bearer and the local Nostr key:
 * POST /nostr/challenge → sign the challenge locally → POST /nostr/link. No browser involved.
 */
export async function linkLocalNostr(deps: LinkLocalDeps = {}): Promise<LinkLocalResult> {
  const session = deps.session !== undefined ? deps.session : readSession(deps.now?.() ?? Date.now());
  if (!session) return { ok: false, reason: "signed-out" };
  const base = deps.base ?? bindConfig().base;
  if (!base) return { ok: false, reason: "no-base" };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const identity = deps.identity ?? loadOrCreateNostrIdentity();
  const auth = { Authorization: `Bearer ${session.sessionToken}` };

  const cRes = await fetchImpl(new URL("/api/account/nostr/challenge", base), { method: "POST", headers: auth });
  if (!cRes.ok) return { ok: false, reason: "challenge-failed", detail: `HTTP ${cRes.status}` };
  const challenge = ((await cRes.json().catch(() => ({}))) as { challenge?: string }).challenge;
  if (!challenge) return { ok: false, reason: "challenge-failed", detail: "no challenge returned" };

  // NIP-42-style proof: an event carrying the challenge tag, signed by the local key. created_at is
  // unix SECONDS per NIP-01.
  const event = identity.signEvent({
    created_at: Math.floor((deps.now?.() ?? Date.now()) / 1000),
    kind: 22242,
    tags: [["challenge", challenge]],
    content: "Link this Nostr key to my AgentGem account",
  });

  const lRes = await fetchImpl(new URL("/api/account/nostr/link", base), {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ event }),
  });
  const body = (await lRes.json().catch(() => ({}))) as { npub?: string; connected?: string[]; error?: string };
  if (!lRes.ok || !body.npub) return { ok: false, reason: "link-failed", detail: body.error ?? `HTTP ${lRes.status}` };
  return { ok: true, npub: body.npub, connected: body.connected ?? [] };
}

/** `agentgem nostr link` — thin CLI wrapper over linkLocalNostr. */
export async function runNostrCommand(argv: string[]): Promise<number> {
  if (argv[0] !== "link") { console.error("usage: agentgem nostr link"); return 1; }
  const r = await linkLocalNostr();
  if (!r.ok) {
    const msg =
      r.reason === "signed-out" ? "sign in first: run `agentgem bind`"
      : r.reason === "no-base" ? "set AGENTGEM_AGGREGATOR_URL (hosted aggregator base URL)"
      : `${r.detail ?? r.reason}`;
    console.error(`agentgem nostr link: ${msg}`);
    return 1;
  }
  console.log(`✓ linked Nostr key ${r.npub}`);
  console.log(`  connected providers: ${r.connected.join(", ")}`);
  return 0;
}
