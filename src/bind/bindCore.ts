// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/bind/bindCore.ts
// Shared core for device-flow binding. Extracted so both the CLI and the console
// REST endpoints share identical logic without duplication.
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity, type Identity } from "@agentgem/model";
import { bindSigningPayload } from "@agentgem/aggregator/binding";
import { requestDeviceCode, pollForToken } from "./deviceFlow.js";

export interface BindConfig { clientId?: string; base?: string }

// The canonical hosted OAuth app + aggregator. The GitHub *device-flow* client ID is
// public (device flow has no client secret), so shipping it as a default lets
// "Connect GitHub" work with zero configuration against api.agentgem.ai. Self-hosters
// override either value via env.
const DEFAULT_GITHUB_CLIENT_ID = "Ov23liCbBVnhr7AH9FkF";
const DEFAULT_AGGREGATOR_URL = "https://api.agentgem.ai";

export function bindConfig(): BindConfig {
  return {
    clientId: process.env.AGENTGEM_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID,
    base: process.env.AGENTGEM_AGGREGATOR_URL ?? DEFAULT_AGGREGATOR_URL,
  };
}

const bindingPath = () => join(homedir(), ".agentgem", "binding.json");
const sessionPath = () => join(homedir(), ".agentgem", "session.json");

export interface LocalSession { sessionToken: string; expiresAt?: string; login?: string; avatarUrl?: string }

/** Read the persisted first-party session, or null if absent/expired/corrupt. Expired sessions are
 *  treated as absent so the caller prompts a reconnect (device flow) rather than sending a dead bearer. */
export function readSession(now: number = Date.now()): LocalSession | null {
  try {
    if (!existsSync(sessionPath())) return null;
    const j = JSON.parse(readFileSync(sessionPath(), "utf8")) as LocalSession;
    if (!j.sessionToken) return null;
    if (j.expiresAt && Date.parse(j.expiresAt) <= now) return null;
    return j;
  } catch {
    return null;
  }
}

/** Remove the persisted session (e.g. after a 401 or on disconnect). Idempotent. */
export function clearSession(): void {
  rmSync(sessionPath(), { force: true });
}

export interface StartDeps { requestCode?: typeof requestDeviceCode }

export async function startDeviceBind(cfg: BindConfig, deps: StartDeps = {}) {
  if (!cfg.clientId) throw new Error("not configured");
  return (deps.requestCode ?? requestDeviceCode)(cfg.clientId);
}

export interface CompleteDeps {
  poll?: typeof pollForToken;
  identity?: Identity;
  fetchImpl?: typeof fetch;
  now?: number;
}

export async function completeDeviceBind(
  cfg: BindConfig,
  args: { deviceCode: string; interval?: number },
  deps: CompleteDeps = {},
): Promise<{ bound: true; provider: string; login: string; accountId: string; avatarUrl?: string; sessionToken?: string; expiresAt?: string } | { bound: false; rejected: string }> {
  if (!cfg.clientId || !cfg.base) return { bound: false, rejected: "not-configured" };
  const token = await (deps.poll ?? pollForToken)(cfg.clientId, args.deviceCode, { intervalSec: args.interval ?? 5 });
  const id = deps.identity ?? loadOrCreateIdentity();
  const signedAt = deps.now ?? Date.now();
  const signature = id.sign(bindSigningPayload(id.publicKey, token, signedAt));
  const res = await (deps.fetchImpl ?? fetch)(new URL("/api/aggregator/bind", cfg.base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey: id.publicKey, token, signedAt, signature }),
  });
  const out = (await res.json()) as { bound: boolean; provider?: string; login?: string; accountId?: string; avatarUrl?: string; rejected?: string; sessionToken?: string; expiresAt?: string };
  if (!out.bound) return { bound: false, rejected: out.rejected ?? "unknown" };
  const dir = join(homedir(), ".agentgem");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    bindingPath(),
    JSON.stringify({ provider: out.provider, login: out.login, accountId: out.accountId, avatarUrl: out.avatarUrl, boundAt: new Date().toISOString() }),
    { mode: 0o600 },
  );
  // Persist the first-party session separately from the pubkey binding. This is the bearer the
  // local API client and the web SSO handoff use; the raw GitHub token is never written to disk.
  if (out.sessionToken) {
    writeFileSync(
      sessionPath(),
      JSON.stringify({ sessionToken: out.sessionToken, expiresAt: out.expiresAt, login: out.login, avatarUrl: out.avatarUrl }),
      { mode: 0o600 },
    );
  }
  return { bound: true, provider: out.provider!, login: out.login!, accountId: out.accountId!, ...(out.avatarUrl ? { avatarUrl: out.avatarUrl } : {}), ...(out.sessionToken ? { sessionToken: out.sessionToken, expiresAt: out.expiresAt } : {}) };
}

// Disconnect: remove the local binding so this machine is no longer verified.
// Idempotent (a missing file is success). Local-only — it un-verifies THIS machine
// but does not revoke the server-side account link; reconnecting via the device
// flow re-links.
export function clearBinding(): { bound: false } {
  rmSync(bindingPath(), { force: true });
  return { bound: false };
}

export function readBindingStatus(): { bound: boolean; login?: string; provider?: string; avatarUrl?: string; sessionActive?: boolean } {
  try {
    if (!existsSync(bindingPath())) return { bound: false };
    const j = JSON.parse(readFileSync(bindingPath(), "utf8")) as { login?: string; provider?: string; avatarUrl?: string };
    // sessionActive tells the UI whether a live first-party session exists (F4): the bind is
    // ~permanent (verified-publishing provenance), but web SSO / Bearer calls need a session, which
    // expires (30d) or may predate the session bridge. The UI gates "Open on the web" on this.
    return j.login ? { bound: true, login: j.login, provider: j.provider, ...(j.avatarUrl ? { avatarUrl: j.avatarUrl } : {}), sessionActive: readSession() !== null } : { bound: false };
  } catch {
    return { bound: false };
  }
}
