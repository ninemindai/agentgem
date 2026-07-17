// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// Live in-process MCP client manager for miniapp connectors (spec §3, 1A/2A/D14).
//
// Distinct from mcpProxy.ts, which only RENDERS a runner script: this owns real @modelcontextprotocol
// /sdk Client connections to the viewer's installed mcp_server gems and pools them. The pool is a
// module singleton because a connector process is expensive to spawn and shared across every miniapp
// call in the session. Concurrency invariants that the race class here demands (a prior index bug in
// this repo cost real debugging — new-index-method-must-join-single-flight-chain):
//   • single-flight connect: two concurrent first calls to a cold gem spawn ONE process, not two.
//   • in-flight-gated idle close: the ~5 min reaper never closes a client with a call in flight.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerArtifact, McpErrorCode } from "@agentgem/model";
import { introspectConfig } from "@agentgem/capture";
import { buildSpawnEnv } from "./mcpEnv.js";
import { mcpServerConfigDigest } from "./mcpDigest.js";

export class ConnectorError extends Error {
  constructor(message: string, readonly code: McpErrorCode) {
    super(message);
    this.name = "ConnectorError";
  }
}

// Reads the gem UNREDACTED (redact: false) — the redacted inventory blanks config.env, which would
// make every stdio gem look secretless. Overridable for tests so they don't need a real ~/.claude.
type Reader = (server: string) => McpServerArtifact | undefined;
let reader: Reader = (server) => introspectConfig({ redact: false }).mcpServers.find((g) => g.name === server);
export function __setConnectorReaderForTest(r: Reader): void {
  reader = r;
}

export function resolveConnectorGem(server: string): McpServerArtifact | undefined {
  return reader(server);
}

// The console pins consent to a digest at approval time and re-sends it on every call (D3/D7); this
// is the live comparand — the CURRENT installed gem's digest, recomputed from disk each call, never
// cached, so a config edit is visible immediately without needing a pool invalidation of its own.
export function resolveConnectorDigest(server: string): string | undefined {
  const g = resolveConnectorGem(server);
  return g ? mcpServerConfigDigest(g) : undefined;
}

const IDLE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;

interface Entry {
  client: Client;
  transport: Transport;
  connecting: Promise<Client> | null;
  inFlight: number;
  idle?: ReturnType<typeof setTimeout>;
  digest?: string; // the gem's config digest AT CONNECT TIME — compared against the live digest below
  // Transports superseded by a reconnect while a call was still in flight on this entry (D14 follow-
  // up): closing them right away would yank the transport out from under that call. They queue here
  // and get closed once callConnectorTool's `finally` drains inFlight back to 0 (see
  // scheduleOldTransportClose / drainDeferredCloses below). Almost always 0 or 1 entries — an array
  // only because a second reconnect could in principle land before the first deferred close drains.
  deferredCloses: Transport[];
}
const pool = new Map<string, Entry>();

// Closes `oldTransport` now if nothing on `entry` is still using it, else queues it to close once
// callConnectorTool's completion path drains inFlight to 0. `entry.inFlight` is entry-scoped (not
// tied to which client a caller captured), so this is deliberately an over-approximation: a caller
// that joined the entry AFTER the reconnect can delay the old transport's close further. That's the
// tradeoff the brief calls for — correctness (never closing a transport a live call still needs) over
// promptness.
async function scheduleOldTransportClose(entry: Entry, oldTransport: Transport): Promise<void> {
  if (entry.inFlight === 0) {
    try {
      await oldTransport.close();
    } catch {
      /* best-effort */
    }
  } else {
    entry.deferredCloses.push(oldTransport);
  }
}

// Drains and closes any old transports queued by scheduleOldTransportClose once inFlight has reached
// 0. Called from callConnectorTool's `finally` right after the decrement. Safe to call speculatively
// (no-ops when inFlight is still >0 or nothing is queued) — the snapshot-and-clear happens
// synchronously before any `await`, so a concurrent push can't be lost or double-closed.
async function drainDeferredCloses(entry: Entry): Promise<void> {
  if (entry.inFlight > 0 || entry.deferredCloses.length === 0) return;
  const closes = entry.deferredCloses;
  entry.deferredCloses = [];
  for (const t of closes) {
    try {
      await t.close();
    } catch {
      /* best-effort */
    }
  }
}

// Spawns the transport and completes the SDK handshake for `gem`. Shared by the cold-connect path
// and the digest-invalidation reconnect path below — neither touches the pool; the caller wires the
// result (or failure) into its own Entry so both paths keep the same single-flight guarantees.
async function connectTransport(server: string, gem: McpServerArtifact): Promise<{ client: Client; transport: Transport }> {
  const client = new Client({ name: "agentgem-connector", version: "1.0.0" }, { capabilities: {} });
  let transport: Transport;
  if (gem.transport === "stdio") {
    const command = String((gem.config as { command?: unknown }).command ?? "");
    const args = Array.isArray((gem.config as { args?: unknown }).args)
      ? ((gem.config as { args: unknown[] }).args as string[])
      : [];
    const { env, missingSecrets } = buildSpawnEnv(gem, process.env);
    if (missingSecrets.length) {
      throw new ConnectorError(
        `MCP server "${server}" is missing required secret(s): ${missingSecrets.join(", ")} — set them in your environment`,
        "server_not_connected",
      );
    }
    transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
  } else {
    // http/sse: import the matching transport lazily so a stdio-only environment doesn't pay for it.
    const url = new URL(String((gem.config as { url?: unknown }).url ?? ""));
    if (gem.transport === "sse") {
      const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
      transport = new SSEClientTransport(url);
    } else {
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(url);
    }
  }
  try {
    await client.connect(transport);
  } catch (e) {
    throw new ConnectorError(`could not connect to MCP server "${server}": ${(e as Error).message}`, "server_unavailable");
  }
  return { client, transport };
}

async function ensureClient(server: string): Promise<Client> {
  const existing = pool.get(server);
  // A connect already in flight is single-flighted as-is: joining callers must NOT re-resolve the
  // gem (that would double-count reads in the single-flight test) or race a second invalidation
  // against the same in-progress connect.
  if (existing?.connecting) return existing.connecting;

  const gem = resolveConnectorGem(server);
  if (!gem) throw new ConnectorError(`no installed MCP server named "${server}"`, "server_not_connected");
  const digest = mcpServerConfigDigest(gem);

  if (existing?.client) {
    if (existing.digest === digest) return existing.client;
    // Config changed since this client connected (D3/D9): a stale client must not silently answer
    // under the old identity. This must join the SAME single-flight discipline as the cold-connect
    // path below: `existing.connecting` is set on the SAME Entry, synchronously, with no `await`
    // in between — the pool is never emptied. A concurrent caller's synchronous `pool.get` (above)
    // then sees `existing.connecting` already set and joins THIS reconnect instead of racing a
    // second one (which previously could spawn two child processes and orphan one of them — see
    // the file-level "new-index-method-must-join-single-flight-chain" note).
    const oldTransport = existing.transport;
    if (existing.idle) clearTimeout(existing.idle);
    existing.digest = digest;
    existing.connecting = (async () => {
      try {
        // Connect the REPLACEMENT first, before touching the old transport at all: a caller already
        // mid-`callConnectorTool` on the old client (entry.inFlight>0) must keep answering on it
        // undisturbed while this reconnect is in progress — see scheduleOldTransportClose below for
        // why the close itself is also gated on inFlight rather than unconditional.
        const { client, transport } = await connectTransport(server, gem);
        existing.client = client;
        existing.transport = transport;
        existing.connecting = null;
        touchIdle(server);
        await scheduleOldTransportClose(existing, oldTransport);
        return client;
      } catch (e) {
        // Same failure-must-not-poison-the-pool rule as the cold path: only drop the entry if it's
        // still OURS (a newer reconnect hasn't already replaced it). The old transport is still live
        // here (we never touched it above) and still may have a call in flight on it — same
        // inFlight-gated close as the success path, not an unconditional one.
        if (pool.get(server) === existing) pool.delete(server);
        await scheduleOldTransportClose(existing, oldTransport);
        throw e;
      }
    })();
    return existing.connecting;
  }

  // IMPORTANT — two invariants depend on this exact ordering:
  //  1. Single-flight: `pool.set(server, entry)` below runs BEFORE the connect work is kicked off,
  //     with no `await` in between. A second concurrent caller's synchronous `pool.get` (above) then
  //     sees `entry.connecting` already set and awaits the SAME promise instead of spawning a second
  //     process.
  //  2. Failure must not poison the pool: a missing-secret gem throws SYNCHRONOUSLY (no `await`
  //     precedes it), so the async IIFE below can run to rejection before this function even reaches
  //     a `pool.set` call that follows it — an earlier version set the pool entry AFTER building the
  //     IIFE and got exactly this bug: the catch's `pool.delete` fired first (a no-op, since nothing
  //     was in the pool yet) and the subsequent `pool.set` then re-inserted the now-permanently-
  //     rejected promise, poisoning the pool forever. Registering `entry` in the pool FIRST — before
  //     the connect work is even started — means the catch below always finds (and removes) it,
  //     regardless of whether the failure happens synchronously or after a real `await`.
  const entry: Entry = {
    client: undefined as unknown as Client,
    transport: undefined as unknown as Entry["transport"],
    connecting: null,
    inFlight: 0,
    digest,
    deferredCloses: [],
  };
  pool.set(server, entry);

  entry.connecting = (async () => {
    try {
      const { client, transport } = await connectTransport(server, gem);
      entry.client = client;
      entry.transport = transport;
      entry.connecting = null;
      touchIdle(server);
      return client;
    } catch (e) {
      // A failed connect must NOT poison the pool: without this, the rejected `connecting` promise
      // stays cached and every later call re-returns the same rejection (missing-secret gems could
      // never recover after the secret is set). Drop OUR OWN entry (never a newer one that may have
      // since replaced it) so the next call retries cleanly.
      if (pool.get(server) === entry) pool.delete(server);
      throw e;
    }
  })();
  return entry.connecting;
}

function touchIdle(server: string): void {
  const e = pool.get(server);
  if (!e) return;
  if (e.idle) clearTimeout(e.idle);
  // In-flight-gated: fires at ~5 min idle, but a call still running just re-arms next touch — it
  // NEVER closes a client out from under an active callTool/listTools.
  e.idle = setTimeout(() => {
    if (e.inFlight === 0) void closeEntry(server);
  }, IDLE_MS);
  e.idle.unref();
}

async function closeEntry(server: string): Promise<void> {
  const e = pool.get(server);
  if (!e) return;
  pool.delete(server);
  if (e.idle) clearTimeout(e.idle);
  // Close the current transport AND any old ones still queued from a reconnect whose inFlight-drain
  // never got the chance to fire (e.g. the entry closes via the idle reaper before that happens) —
  // otherwise those old child processes leak.
  const deferred = e.deferredCloses;
  e.deferredCloses = [];
  for (const t of [e.transport, ...deferred]) {
    try {
      await t?.close();
    } catch {
      /* best-effort */
    }
  }
}

export async function listConnectorTools(
  server: string,
): Promise<{ name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]> {
  const client = await ensureClient(server);
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    annotations: t.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
  }));
}

export async function callConnectorTool(
  server: string,
  tool: string,
  input: unknown,
  opts?: { timeoutMs?: number },
): Promise<{ content: unknown[]; structuredContent?: unknown }> {
  const client = await ensureClient(server);
  const entry = pool.get(server)!;
  entry.inFlight++;
  try {
    const result = await client.callTool(
      { name: tool, arguments: (input ?? {}) as Record<string, unknown> },
      undefined,
      { timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS },
    );
    if ((result as { isError?: boolean }).isError) throw new ConnectorError(`tool "${tool}" reported an error`, "tool_error");
    return {
      content: (result.content ?? []) as unknown[],
      structuredContent: (result as { structuredContent?: unknown }).structuredContent,
    };
  } catch (e) {
    if (e instanceof ConnectorError) throw e;
    // The SDK raises McpError(RequestTimeout) for a hung request — treat that as transient/
    // unavailable; a tool that ran and reported failure (thrown handler error or isError) is tool_error.
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) {
      throw new ConnectorError(`MCP server "${server}" timed out`, "server_unavailable");
    }
    throw new ConnectorError(`tool "${tool}" failed: ${(e as Error).message ?? ""}`, "tool_error");
  } finally {
    entry.inFlight--;
    touchIdle(server);
    // The call-completion hook a deferred reconnect-close is waiting on (see
    // scheduleOldTransportClose) — a no-op unless this decrement just brought inFlight to 0 AND a
    // reconnect actually queued something.
    void drainDeferredCloses(entry);
  }
}

export async function __resetConnectorsForTest(): Promise<void> {
  for (const server of [...pool.keys()]) await closeEntry(server);
}
