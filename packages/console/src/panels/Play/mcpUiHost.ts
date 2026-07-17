// packages/console/src/panels/Play/mcpUiHost.ts
// The MCP Apps `ui/*` JSON-RPC host router: the trusted end of the postMessage conversation the embedded
// `mcpAppClient` shim (packages/play) drives from inside a sealed miniapp iframe. It is the standard-wire
// successor to Runner.tsx's private `agentgem:request`/`agentgem:feed` broker — same behavior, new wire.
//
// Faithful to Runner.serve() + its message handler (Runner.tsx): the per-instance single-flight guards
// (one live stream, one invoke turn, one chat-open) and the game-generation staleness pin that used to
// live as Runner refs now live here as router state; the stateless data/stream shapes come from
// mcpHostTools (Task 1). Consent, remembered choices, and thumbnail suppression stay OUT of here — the
// router calls the injected `requestConsent(cap)` for gated caps (AUTO caps bypass it); the Runner (PR D)
// supplies that callback. This module is inert: nothing imports it yet.
import type { McpNeed } from "@agentgem/model";
import { AUTO_CAPS, getMcpConsent, setMcpConsent, clearMcpConsent } from "./consent.js";
import {
  getSessionData, getInventory, subscribeSessions, subscribeHygiene, openNeutralChat, invokeAgent,
  CAP_TOOL, TOOL_CAP, HOST_TOOLS, type StreamHandle,
} from "./mcpHostTools.js";
import { playMcpCallRoute, playMcpServersRoute, makeClient } from "../../api/routes.js";
import { mcpIdentity, McpIdentityError } from "./mcpIdentity.js";

// The MCP Apps extension's protocol revision this host implements (ext-apps MVP, 2026-01-26).
const PROTOCOL_VERSION = "2026-01-26";

// The watch registry's poll cadence AND its rate floor — deliberately the SAME constant. Every
// deps.schedule() call the registry makes (regular tick, floor-deferred retry, dirty follow-up) uses
// this value, so "the next scheduled poll" and "the earliest a poll may legally run again" always
// coincide; no separate floor-vs-interval bookkeeping is needed. (D2 spec: watches poll no more than
// once per 30s per identity.)
const POLL_INTERVAL_MS = 30_000;

// authz-denial-or-reconfig codes that STOP a watch (retract + drop the grant) rather than just
// reporting a transient error and keeping the last good result. Mirrors D2's mid-stream contract.
const WATCH_STOP_CODES = new Set(["server_config_changed", "needs_reauth", "not_granted", "server_not_connected"]);

export interface UiHostDeps {
  apiBase: string;
  name: string;
  needs: string[];
  interactive: boolean;
  target: Window;                                    // the iframe.contentWindow: post target + e.source boundary
  requestConsent: (cap: string, detail?: string) => Promise<boolean>; // gated caps only; AUTO caps bypass. Runner owns the modal. `detail` surfaces extra context (e.g. the open-link URL) to the prompt.
  hostContext?: () => Record<string, unknown>;       // PR 3 wires the Runner's live theme/size; PR 2: absent -> {}
  onDisplayMode?: (mode: string) => string;          // PR 3: Runner applies/refuses; returns the mode ACTUALLY applied
  openExternal?: (url: string) => void;              // 3.4: open-link's actual browser navigation, injected by the Runner
  copyText?: (text: string) => void;                 // copy-command's actual clipboard write, injected by the Runner
  mcpNeeds?: McpNeed[];                               // declared connector manifest (Runner, Task 6); absent = no connectors
  // Watch-registry timing, injected so this module stays DOM-free (Task 3). `schedule` arms a one-shot
  // timer and returns its cancel fn — the Runner supplies a real setTimeout wrapper (Task 6); a fake
  // "manual clock" drives it in tests. `isHidden` reports the tab's current visibility. Both absent ->
  // the registry still answers the FIRST poll of a register (so replay/consent/D11 stay fully testable)
  // but never arms a recurring timer, i.e. a degraded "replay-only, no background polling" mode.
  schedule?: (fn: () => void, ms: number) => () => void;
  isHidden?: () => boolean;
}

export interface UiHost {
  handleMessage(e: MessageEvent): void;
  dispose(): void;
  bumpGeneration(): void;
  feedSessionData(sessionId: string, agent: string): void; // host-initiated "Replay yours" rebind
  rebindHygiene(file: string): void;                        // host-initiated hygiene-stream rebind (session picker)
  pushHostContext(partial: Record<string, unknown>): void;  // host-initiated host-context-changed push (fullscreen toggle)
  wakeWatches(): void;                                       // host-initiated visibility catch-up (Runner's visibilitychange listener, Task 6)
}

// A registered `mcp/watch`'s poll state (router-internal). One entry per mcpIdentity(server,tool,body)
// key; N watchIds can share one entry (coalesced polling). `epoch` bumps whenever this identity's entry
// is replaced (a fresh register after the old one stopped) so an async continuation from the OLD entry
// can tell it's obsolete even if a NEW entry now occupies the same map key.
interface WatchEntry {
  identity: string; epoch: number;
  server: string; tool: string; body: unknown;
  watchers: Map<number, true>;
  lastGood?: { payload: unknown; content: unknown[]; storedAt: number };
  stoppedReason?: string;
  inFlight: boolean; dirty: boolean; nextAllowedAt: number;
  cancelTimer?: () => void;
}

// A tool as loadServers() reports it: name plus the annotations D11's readOnlyHint gate reads (Task 3).
interface McpServerTool {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

interface RpcMessage {
  jsonrpc?: string; id?: number; method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; url?: string } & Record<string, unknown>;
}

export function createUiHost(deps: UiHostDeps): UiHost {
  let generation = 0;                                // bumped per game; async continuations pin to their start value
  const handles = new Set<StreamHandle>();           // open streams to close on dispose / stale
  // Single-flight guards — the exact set Runner.serve() kept as refs.
  let liveOpen = false;                              // one live-session-events stream
  let hygieneOpen = false;                            // one context-hygiene stream
  let hygieneHandle: StreamHandle | null = null;      // that stream's handle — rebindHygiene closes JUST this one
  let invoking = false;                              // one invoke-agent turn at a time
  let chatId: string | null = null;                  // reused neutral chat session
  let chatPromise: Promise<string> | null = null;    // in-flight chat-open (serialize concurrent invokes)
  let feeding = false;                                // one in-flight feedSessionData at a time (mirrors Runner's feedingRef)
  const mcpNeeds = deps.mcpNeeds ?? [];               // declared-authoritative connector manifest, resolved once
  // server -> last-seen configDigest; `undefined` means "not installed". Refreshed by loadServers() before
  // every consent decision so a swapped/uninstalled connector is caught even mid-session.
  const mcpDigests = new Map<string, string | undefined>();
  // The watch registry: identity (mcpIdentity key) -> its poll state, capped at 16 live identities.
  // watchOwners is the reverse index (watchId -> identity) so unwatch is O(1) instead of scanning every
  // entry's watchers map.
  const watches = new Map<string, WatchEntry>();
  const watchOwners = new Map<number, string>();
  let entryEpochSeq = 0;
  let watchIdSeq = 1;

  const post = (msg: unknown) => deps.target.postMessage(msg, "*");
  const stale = (gen: number) => gen !== generation;
  const reply = (id: number | undefined, result: unknown) => { if (id != null) post({ jsonrpc: "2.0", id, result }); };
  const replyError = (id: number | undefined, code: number, message: string) => { if (id != null) post({ jsonrpc: "2.0", id, error: { code, message } }); };
  // Spec: a tool-result notification's params IS a CallToolResult. Stream identity + sequencing ride the
  // spec's sanctioned _meta passthrough, so a conformant external host relays it and a conformant client
  // ignores it. Our shim (mcpAppClient.ts) unwraps it back to {toolName, chunk}.
  const notify = (toolName: string, chunk: unknown) => post({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: {
      content: [],
      structuredContent: chunk,
      _meta: { "ai.agentgem/stream": { toolName } },
    },
  });
  // Watch notifications ride the same tool-result notification channel as the tools/call stream, but
  // tagged under a DISTINCT _meta key (`ai.agentgem/watch` vs `ai.agentgem/stream`) carrying the
  // watchId, so Task 5's shim can route a chunk to the right watchTool() subscriber instead of the
  // generic streaming-tool handler.
  const notifyWatch = (watchId: number, type: "data" | "error", payload: unknown) => post({
    jsonrpc: "2.0", method: "ui/notifications/tool-result",
    params: { content: [], structuredContent: payload, _meta: { "ai.agentgem/watch": { watchId, type } } },
  });
  const notifyEntry = (entry: WatchEntry, type: "data" | "error", payload: unknown) => {
    for (const watchId of entry.watchers.keys()) notifyWatch(watchId, type, payload);
  };
  const register = (gen: number, handle: StreamHandle) => {
    if (stale(gen)) { try { handle.close(); } catch { /* ignore */ } } else handles.add(handle);
  };
  // Host-initiated push (fullscreen toggle, button- or request-driven): not a reply to any `id`, so the
  // game's onNotification handler picks it up the same way it does tool-result chunks.
  const notifyCtx = (partial: Record<string, unknown>) =>
    post({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: partial });
  function pushHostContext(partial: Record<string, unknown>): void { notifyCtx(partial); }

  // Execute a permitted capability. One-shot caps reply with the JSON-RPC result; streaming caps reply
  // with an ack and push each event via a notification. Mirrors Runner.serve()'s per-cap branches.
  async function execute(cap: string, id: number | undefined, args: Record<string, unknown>, gen: number): Promise<void> {
    const tool = CAP_TOOL[cap];
    try {
      if (cap === "session-data") {
        // AUTO cap, no consent prompt: never forward the miniapp-supplied sessionId/agent — the sealed
        // miniapp must not be able to pick an arbitrary session. Name-only (its own source session); the
        // explicit-session rebind is host-initiated only (Runner's "Replay yours" picker, PR D).
        const data = await getSessionData(deps.apiBase, deps.name);
        if (!stale(gen)) reply(id, data);
        return;
      }
      if (cap === "local-project-access") {
        const data = await getInventory(deps.apiBase);
        if (!stale(gen)) reply(id, data);
        return;
      }
      if (cap === "live-session-events") {
        if (liveOpen) { reply(id, { status: "already-subscribed" }); return; } // idempotent — one stream per game
        liveOpen = true;
        try {
          const r = await subscribeSessions(deps.apiBase, (ev) => { if (!stale(gen)) notify(tool, ev); });
          if (stale(gen)) { if (r.status === "subscribed") { try { r.handle.close(); } catch { /* ignore */ } } liveOpen = false; return; }
          if (r.status === "idle") { liveOpen = false; reply(id, { status: "idle" }); return; } // release so a later retry can succeed
          register(gen, r.handle);
          reply(id, { status: "subscribed" });
        } catch (e) { liveOpen = false; throw e; }                              // release the guard so a retry can succeed
        return;
      }
      if (cap === "context-hygiene") {
        if (hygieneOpen) { reply(id, { status: "already-subscribed" }); return; } // idempotent — one stream per game
        hygieneOpen = true;
        try {
          const r = await subscribeHygiene(deps.apiBase, (ev) => { if (!stale(gen)) notify(tool, ev); });
          if (stale(gen)) { if (r.status === "subscribed") { try { r.handle.close(); } catch { /* ignore */ } } hygieneOpen = false; return; }
          if (r.status === "idle") { hygieneOpen = false; reply(id, { status: "idle" }); return; } // release so a later retry can succeed
          register(gen, r.handle);
          hygieneHandle = r.handle;
          reply(id, { status: "subscribed" });
        } catch (e) { hygieneOpen = false; throw e; }                            // release the guard so a retry can succeed
        return;
      }
      if (cap === "invoke-agent") {
        const message = typeof args.message === "string" ? args.message : undefined;
        if (!message || invoking) { reply(id, { status: "busy" }); return; }   // each invoke carries a prompt; one turn at a time
        if (!chatId) {
          // Serialize chat-open so two fast invokes don't spawn two sessions (check-then-set race).
          if (!chatPromise) chatPromise = openNeutralChat(deps.apiBase);        // neutral (read-only) — no miniapp field
          try { chatId = await chatPromise; }
          catch (e) { chatPromise = null; throw e; }                           // release so a later invoke can re-open (mirrors liveOpen :85)
        }
        if (stale(gen)) return;
        invoking = true;
        register(gen, invokeAgent(deps.apiBase, chatId, message, {
          onDelta: (text) => { if (!stale(gen)) notify(tool, { kind: "delta", text }); },
          onTool: (t) => { if (!stale(gen)) notify(tool, { kind: "tool", tool: t }); },
          onDone: () => { invoking = false; if (!stale(gen)) notify(tool, { kind: "done" }); },
          onFailed: (error) => { invoking = false; if (!stale(gen)) notify(tool, { kind: "failed", error }); },
        }));
        reply(id, { status: "invoking" });
        return;
      }
    } catch {
      // No host data (fetch/stream failed) — Runner.serve() silently swallows and lets the game show its
      // waiting/failed state. Over this wire the call carries an id, so answer it (reject) rather than hang.
      if (!stale(gen)) replyError(id, -32000, "host data unavailable");
    }
  }

  // Resolve tool -> capability, enforce cap ∈ needs (per-call, not advertisement-only), then AUTO-execute
  // or gate on requestConsent. Mirrors Runner.tsx's message handler (AUTO_CAPS + needs.includes).
  async function handleCall(d: RpcMessage): Promise<void> {
    const name = d.params?.name ?? "";
    const args = d.params?.arguments ?? {};
    const cap = TOOL_CAP[name];
    if (!cap || !deps.needs.includes(cap)) { replyError(d.id, -32601, `capability not permitted: ${name}`); return; }
    const gen = generation;
    if (!AUTO_CAPS.has(cap)) {
      const ok = await deps.requestConsent(cap);
      if (stale(gen)) return;                        // game changed while the prompt was open
      if (!ok) { replyError(d.id, -32001, "consent denied"); return; }
    }
    await execute(cap, d.id, args, gen);
  }

  // ui/open-link: real console semantics — consent (showing the URL, never remembered — see
  // requestConsent's "open-link" branch in Runner.tsx) then delegate the actual navigation to the
  // injected `openExternal` so this module stays DOM-free.
  async function handleOpenLink(d: RpcMessage): Promise<void> {
    const cap = "open-link";
    if (!deps.needs.includes(cap)) { replyError(d.id, -32601, `capability not permitted: ${cap}`); return; }
    const url = d.params?.url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) { replyError(d.id, -32602, "invalid params: url must be an http(s) string"); return; }
    const gen = generation;
    const ok = await deps.requestConsent(cap, url);
    if (stale(gen)) return;                            // game changed while the prompt was open
    if (!ok) { replyError(d.id, -32001, "consent denied"); return; }
    deps.openExternal?.(url);
    reply(d.id, {});
  }

  // ui/copy-command: write a short command to the OS clipboard. Same posture as open-link — consent-gated,
  // NEVER remembered, and the modal shows the exact `text` (Runner treats it like open-link) so a shared
  // miniapp can't silently swap the copied string between grants. Length-capped to bound the payload.
  async function handleCopy(d: RpcMessage): Promise<void> {
    const cap = "copy-command";
    if (!deps.needs.includes(cap)) { replyError(d.id, -32601, `capability not permitted: ${cap}`); return; }
    const text = d.params?.text;
    if (typeof text !== "string" || text.length === 0 || text.length > 256) { replyError(d.id, -32602, "invalid params: text must be a 1-256 char string"); return; }
    const gen = generation;
    const ok = await deps.requestConsent(cap, text);
    if (stale(gen)) return;                            // game changed while the prompt was open
    if (!ok) { replyError(d.id, -32001, "consent denied"); return; }
    deps.copyText?.(text);
    reply(d.id, {});
  }

  // ui/message / ui/update-model-context: only meaningful in an EXTERNAL chat host (Claude Desktop) that
  // spawned the miniapp — the console Play panel has no conversation sink to write into. Still enforce
  // the needs gate (a game that never declared the cap gets -32601 either way), but a declared-and-denied
  // cap here means "recognized, not supported by this host" rather than a consent prompt.
  function handleUnsupportedAction(d: RpcMessage, cap: string): void {
    if (!deps.needs.includes(cap)) { replyError(d.id, -32601, `capability not permitted: ${cap}`); return; }
    replyError(d.id, -32601, "unsupported by this host");
  }

  // Refresh the router's view of every declared connector: install state (configDigest present/absent)
  // and its live tool list. Called before every consent decision — never cached across calls — so a
  // connector uninstalled or reconfigured mid-session is caught rather than trusted from a stale read.
  async function loadServers(): Promise<Map<string, { tools: McpServerTool[]; configDigest?: string }>> {
    const res = await playMcpServersRoute.call(makeClient(deps.apiBase), { query: { name: deps.name } });
    const map = new Map<string, { tools: McpServerTool[]; configDigest?: string }>();
    for (const s of res.servers) {
      map.set(s.server, { tools: s.tools, configDigest: s.configDigest });
      mcpDigests.set(s.server, s.configDigest);
    }
    return map;
  }

  // The consent-card detail string the Runner's modal renders (Task 6) — names the server and every tool
  // the miniapp declared against it, so the viewer approves the whole grant, not a single blind call.
  function mcpDetail(server: string): string {
    const need = mcpNeeds.find((n) => n.server === server);
    return `${server} (tools: ${need?.tools.join(", ") ?? ""})`;
  }

  // mcp/list: a NON-prompting status readout for the miniapp's declared connectors (Task 6's picker UI).
  // Never calls requestConsent — only getMcpConsent — and never puts the configDigest in the reply; it
  // exists purely to pin consent, not to be forwarded to the sealed iframe.
  async function handleMcpList(d: RpcMessage): Promise<void> {
    const gen = generation;
    let serverMap: Map<string, { tools: McpServerTool[]; configDigest?: string }>;
    try {
      serverMap = await loadServers();
    } catch {
      // /servers is unreachable (miniapp deleted mid-session, network blip, core error) — reply the same
      // degraded shape as a not-installed server so the miniapp renders its no-connector state instead of
      // hanging forever on an unsettled callTool/listTools promise (see handleMcpCall's twin catch below).
      if (!stale(gen)) reply(d.id, { servers: mcpNeeds.map((need) => ({ server: need.server, tools: [] as string[], status: "unavailable" as const })) });
      return;
    }
    if (stale(gen)) return;
    const servers = mcpNeeds.map((need) => {
      const digest = serverMap.get(need.server)?.configDigest;
      if (digest === undefined) return { server: need.server, tools: [] as string[], status: "unavailable" as const };
      const c = getMcpConsent(deps.name, need.server);
      if (c?.decision === "granted" && c.digest === digest) {
        const connectorTools = new Set((serverMap.get(need.server)?.tools ?? []).map((t) => t.name));
        return { server: need.server, tools: need.tools.filter((t) => connectorTools.has(t)), status: "granted" as const };
      }
      const status = c?.decision === "denied" && c.digest === digest ? "denied" as const : "needsConsent" as const;
      return { server: need.server, tools: [] as string[], status };
    });
    reply(d.id, { servers });
  }

  // mcp/call: THE consent decision lives here (the router holds the digest a card must pin to);
  // requestConsent stays a dumb yes/no modal. Order matters — manifest fast-reject before any network
  // call or prompt, then the digest refresh, then the single consent gate every outcome funnels through.
  async function handleMcpCall(d: RpcMessage): Promise<void> {
    const server = d.params?.server as string | undefined;
    const tool = d.params?.tool as string | undefined;
    const input = d.params?.input;
    const gen = generation;
    const need = mcpNeeds.find((n) => n.server === server);
    if (!server || !tool || !need || !need.tools.includes(tool)) {
      reply(d.id, { ok: false, error: { code: "not_in_manifest", message: `"${server}"/"${tool}" is not in this miniapp's declared connectors` } });
      return;
    }
    try {
      await loadServers();
    } catch {
      // Same rejection as handleMcpList's catch (e.g. the miniapp was deleted from the registry mid-session
      // so /servers 404s, or the core errors) — reply a coded error rather than letting the handler promise
      // reject under `void handleMcpCall(d)`, which would leave the shim's callTool promise unsettled forever.
      if (!stale(gen)) reply(d.id, { ok: false, error: { code: "server_unavailable", message: "could not reach the connector service" } });
      return;
    }
    if (stale(gen)) return;
    const digest = mcpDigests.get(server);
    if (digest === undefined) {
      reply(d.id, { ok: false, error: { code: "server_not_connected", message: `MCP server "${server}" is not installed` } });
      return;
    }
    const c = getMcpConsent(deps.name, server);
    if (c?.decision === "granted" && c.digest === digest) {
      // proceed — matching-digest grant already on file
    } else if (c?.decision === "denied" && c.digest === digest) {
      reply(d.id, { ok: false, error: { code: "not_granted", message: "consent denied" } });
      return;
    } else {
      // No decision on file, or one pinned to a digest that no longer matches (reconfigured connector) —
      // re-prompt. This is the ONLY path to playMcpCallRoute below; there is no bypass.
      const ok = await deps.requestConsent("mcp:" + server, mcpDetail(server));
      if (stale(gen)) return;
      setMcpConsent(deps.name, server, ok ? "granted" : "denied", digest);
      if (!ok) { reply(d.id, { ok: false, error: { code: "not_granted", message: "consent denied" } }); return; }
    }
    const res = await playMcpCallRoute.call(makeClient(deps.apiBase), {
      body: { name: deps.name, server, tool, input, expectedConfigDigest: digest },
    });
    if (stale(gen)) return;
    if (!res.ok && res.error?.code === "server_config_changed") {
      // The server re-derived a different digest since we last read it — the grant no longer means
      // anything. Drop both caches so the NEXT call re-prompts against the new config; don't auto-retry.
      mcpDigests.delete(server);
      clearMcpConsent(deps.name, server);
    }
    reply(d.id, res);
  }

  // Arm this entry's next poll timer, ms away (>= POLL_INTERVAL_MS — see the const's comment). Cancels
  // any timer already armed for this entry first, so re-arming never leaves two live timers racing.
  // No-ops when the host wasn't given a scheduler (Task 6 not wired) — the degraded replay-only mode.
  function armTimer(entry: WatchEntry): void {
    if (!deps.schedule) return;
    if (entry.cancelTimer) { try { entry.cancelTimer(); } catch { /* ignore */ } }
    const waitMs = Math.max(POLL_INTERVAL_MS, entry.nextAllowedAt - Date.now());
    entry.cancelTimer = deps.schedule(() => { entry.cancelTimer = undefined; runPoll(entry); }, waitMs);
  }

  // The single place that decides whether an entry gets a NEXT timer at all: stopped entries never do;
  // a hidden tab gets none either (deps.isHidden — no point polling what nobody's looking at), and
  // relies entirely on wakeWatches() to catch up once the Runner reports visibility returning.
  function scheduleNext(entry: WatchEntry): void {
    if (entry.stoppedReason) return;
    if (deps.isHidden?.()) return;
    armTimer(entry);
  }

  // Set stoppedReason, drop the grant that's no longer valid (config changed out from under it, or an
  // authz denial), cancel the timer, and retract — notify every current watcher with `stop:true` so the
  // shim can surface "this watch ended" rather than silently going quiet. The entry itself is KEPT (not
  // deleted from `watches`): a late in-flight poll from before the stop still finds it (via the epoch/gen
  // re-check in pollOnce) and drops rather than crashing on a missing entry; existing watchIds can still
  // be explicitly unwatched. A NEW register on this identity won't join it (handleWatch's `stoppedReason`
  // check) — it always re-runs the full interactive consent decision and creates a fresh entry instead.
  function stopWatch(entry: WatchEntry, code: string, message?: string): void {
    entry.stoppedReason = code;
    if (entry.cancelTimer) { try { entry.cancelTimer(); } catch { /* ignore */ } entry.cancelTimer = undefined; }
    clearMcpConsent(deps.name, entry.server);
    mcpDigests.delete(entry.server);
    notifyEntry(entry, "error", { ok: false, error: { code, message: message ?? "the connector grant was retracted" }, stop: true });
  }

  // The single-flight gate every trigger (initial register, interval tick, visibility catch-up) funnels
  // through: an in-flight poll just gets flagged dirty (coalesced into exactly one follow-up once it's
  // free); a poll that isn't allowed yet (the 30s floor hasn't elapsed since the last one STARTED) just
  // re-arms rather than calling early. Only once both gates clear does it actually flip inFlight and
  // kick off pollOnce — capturing this identity's epoch and the router's generation BEFORE the first
  // await, so pollOnce's completion can tell whether it's still the entry anyone cares about.
  function runPoll(entry: WatchEntry): void {
    if (entry.stoppedReason) return;
    if (entry.inFlight) { entry.dirty = true; return; }
    const now = Date.now();
    if (now < entry.nextAllowedAt) { scheduleNext(entry); return; }
    entry.inFlight = true;
    entry.nextAllowedAt = now + POLL_INTERVAL_MS;
    const epoch = entry.epoch;
    const gen = generation;
    void pollOnce(entry, epoch, gen);
  }

  async function pollOnce(entry: WatchEntry, epoch: number, gen: number): Promise<void> {
    const identity = entry.identity;
    // Non-interactive re-check: the poll reuses the registration's grant and NEVER prompts (D2 mirrors
    // window.claude.mcp here). If something else already dropped the grant (another handler saw
    // server_config_changed and cleared it) there's no point calling — stop-and-retract right away.
    const digest = mcpDigests.get(entry.server);
    const c = getMcpConsent(deps.name, entry.server);
    const grantedNow = digest !== undefined && c?.decision === "granted" && c.digest === digest;
    if (!grantedNow) {
      if (watches.get(identity) === entry && entry.epoch === epoch && !stale(gen)) {
        stopWatch(entry, digest === undefined ? "server_not_connected" : "not_granted");
      }
      entry.inFlight = false;
      return;
    }
    let res: { ok: boolean; payload?: unknown; content?: unknown[]; error?: { code: string; message: string } };
    try {
      res = await playMcpCallRoute.call(makeClient(deps.apiBase), {
        body: { name: deps.name, server: entry.server, tool: entry.tool, input: entry.body, expectedConfigDigest: digest },
      });
    } catch {
      res = { ok: false, error: { code: "server_unavailable", message: "could not reach the connector service" } };
    }
    // Entry-epoch + generation re-check — load-bearing: this is the ONLY thing standing between a
    // torn-down/replaced/stale-game entry and a notify or cache-write that shouldn't happen. Every
    // async continuation in this registry re-reads the registry and checks both before acting.
    if (watches.get(identity) !== entry || entry.epoch !== epoch || stale(gen)) {
      entry.inFlight = false;
      return;
    }
    if (res.ok) {
      entry.lastGood = { payload: res.payload, content: res.content ?? [], storedAt: Date.now() };
      notifyEntry(entry, "data", { ok: true, payload: res.payload, content: res.content ?? [] });
      entry.inFlight = false;
      afterPoll(entry);
      return;
    }
    const code = res.error?.code ?? "upstream_error";
    if (WATCH_STOP_CODES.has(code)) {
      entry.inFlight = false;
      stopWatch(entry, code, res.error?.message);
      return;
    }
    // Transient (server_unavailable/tool_error/upstream_error/...): report it live, but keep lastGood —
    // a replay for a NEW watcher must never hand out a stale transient error, only the last good result.
    notifyEntry(entry, "error", { ok: false, error: res.error });
    entry.inFlight = false;
    afterPoll(entry);
  }

  // Runs after every poll that didn't stop the watch. `dirty` means at least one trigger (interval tick,
  // visibility catch-up) arrived while this poll was in flight and wants exactly one follow-up — honor it
  // by attempting a poll right away rather than waiting for whatever timer happens to be armed next;
  // runPoll's own inFlight/floor gates decide whether that attempt actually calls now or just re-arms, so
  // this can never race ahead of the 30s floor. No dirty trigger -> just keep the normal interval alive.
  function afterPoll(entry: WatchEntry): void {
    if (entry.dirty) { entry.dirty = false; runPoll(entry); return; }
    scheduleNext(entry);
  }

  // Host-initiated visibility catch-up (Runner's visibilitychange listener, Task 6 calls this when the
  // tab becomes visible again). Every live, non-stopped entry gets a runPoll() nudge — the single-flight
  // + floor gates inside runPoll decide whether that actually fires a call now or just re-arms.
  function wakeWatches(): void {
    for (const entry of watches.values()) {
      if (entry.stoppedReason) continue;
      runPoll(entry);
    }
  }

  // mcp/watch: register a POLLED read against a connector tool. Reuses mcp/call's exact manifest +
  // digest-consent decision (no bypass), plus two watch-only gates D8 doesn't need: D11 (the tool must
  // be server-declared read-only — watch polls it unattended, so an unannotated or mutating tool is
  // fail-closed rejected) and the 16-identity cap. A register for an identity that's already live
  // coalesces (adds a watchId, no new poll); one already STOPPED is never joined — it's replaced by a
  // fresh entry that goes through the full consent decision again, same as any new identity.
  async function handleWatch(d: RpcMessage): Promise<void> {
    const server = d.params?.server as string | undefined;
    const tool = d.params?.tool as string | undefined;
    const input = d.params?.input;
    const gen = generation;
    if (!server || !tool) {
      reply(d.id, { ok: false, error: { code: "bad_request", message: "mcp/watch requires server and tool" } });
      return;
    }
    let identity: string, body: unknown;
    try {
      const r = mcpIdentity(server, tool, input);
      identity = r.key; body = r.body;
    } catch (err) {
      reply(d.id, { ok: false, error: { code: "bad_request", message: err instanceof McpIdentityError ? err.message : "invalid input" } });
      return;
    }
    const need = mcpNeeds.find((n) => n.server === server);
    if (!need || !need.tools.includes(tool)) {
      reply(d.id, { ok: false, error: { code: "not_in_manifest", message: `"${server}"/"${tool}" is not in this miniapp's declared connectors` } });
      return;
    }
    let serverMap: Map<string, { tools: McpServerTool[]; configDigest?: string }>;
    try {
      serverMap = await loadServers();
    } catch {
      if (!stale(gen)) reply(d.id, { ok: false, error: { code: "server_unavailable", message: "could not reach the connector service" } });
      return;
    }
    if (stale(gen)) return;
    // D11: watch polls this tool unattended, forever, with no per-call consent prompt — so it fail-closed
    // requires the SERVER to have declared the tool side-effect-free. Absent annotations (unknown safety)
    // are rejected exactly like an explicit readOnlyHint:false; only an explicit `true` passes.
    const toolInfo = serverMap.get(server)?.tools.find((t) => t.name === tool);
    if (toolInfo?.annotations?.readOnlyHint !== true) {
      reply(d.id, { ok: false, error: { code: "bad_request", message: `tool "${tool}" is not declared read-only (readOnlyHint must be true) — watch requires a read-only tool` } });
      return;
    }
    const digest = mcpDigests.get(server);
    if (digest === undefined) {
      reply(d.id, { ok: false, error: { code: "server_not_connected", message: `MCP server "${server}" is not installed` } });
      return;
    }
    // The same digest-consent decision as mcp/call — granted+matching digest proceeds silently; a stale
    // or absent decision re-prompts. This is the ONLY path past this point; a coalesced join (below)
    // still runs it, so a stopped-then-rejoined identity always gets a fresh, real consent decision.
    const c = getMcpConsent(deps.name, server);
    if (c?.decision === "granted" && c.digest === digest) {
      // proceed — matching-digest grant already on file
    } else if (c?.decision === "denied" && c.digest === digest) {
      reply(d.id, { ok: false, error: { code: "not_granted", message: "consent denied" } });
      return;
    } else {
      const ok = await deps.requestConsent("mcp:" + server, mcpDetail(server));
      if (stale(gen)) return;
      setMcpConsent(deps.name, server, ok ? "granted" : "denied", digest);
      if (!ok) { reply(d.id, { ok: false, error: { code: "not_granted", message: "consent denied" } }); return; }
    }

    const watchId = watchIdSeq++;
    const existing = watches.get(identity);
    if (existing && !existing.stoppedReason) {
      // Coalesce: join the live entry, no new poll. Ack first, then deliver any cached lastGood as a
      // microtask (never synchronously inside the handler) — and re-verify epoch/gen/membership at that
      // point too, since a microtask is still an async continuation under the same contract as a poll.
      existing.watchers.set(watchId, true);
      watchOwners.set(watchId, identity);
      reply(d.id, { watchId });
      if (existing.lastGood) {
        const snap = existing.lastGood;
        const capturedEpoch = existing.epoch;
        queueMicrotask(() => {
          if (watches.get(identity) !== existing || existing.epoch !== capturedEpoch || stale(gen)) return;
          if (!existing.watchers.has(watchId)) return;
          notifyWatch(watchId, "data", { ok: true, payload: snap.payload, content: snap.content });
        });
      }
      return;
    }
    // Cap 16: only gates a genuinely NEW identity — re-registering (or rejoining a stopped) one already
    // occupying a slot never grows the map.
    if (!existing && watches.size >= 16) {
      reply(d.id, { ok: false, error: { code: "bad_request", message: "too many active watches (max 16)" } });
      return;
    }
    const entry: WatchEntry = {
      identity, epoch: ++entryEpochSeq, server, tool, body,
      watchers: new Map([[watchId, true]]),
      inFlight: false, dirty: false, nextAllowedAt: 0,
    };
    watches.set(identity, entry);
    watchOwners.set(watchId, identity);
    reply(d.id, { watchId });
    runPoll(entry);
  }

  // mcp/unwatch: idempotent — an unknown or already-removed watchId is a silent no-op, not an error (the
  // shim may race a stop-retract with its own unwatch). When the last watcher for an identity leaves, the
  // timer is cancelled and the entry is deleted outright (not kept, unlike a stop — there's nothing to
  // protect a later poll from: there IS no later poll, the timer's gone).
  function handleUnwatch(d: RpcMessage): void {
    const watchId = d.params?.watchId as number | undefined;
    if (typeof watchId !== "number") { reply(d.id, { ok: true }); return; }
    const identity = watchOwners.get(watchId);
    if (identity === undefined) { reply(d.id, { ok: true }); return; }
    watchOwners.delete(watchId);
    const entry = watches.get(identity);
    if (entry) {
      entry.watchers.delete(watchId);
      if (entry.watchers.size === 0) {
        if (entry.cancelTimer) { try { entry.cancelTimer(); } catch { /* ignore */ } entry.cancelTimer = undefined; }
        watches.delete(identity);
      }
    }
    reply(d.id, { ok: true });
  }

  function handleMessage(e: MessageEvent): void {
    if (e.source !== deps.target) return;            // only our own sealed iframe — the security boundary
    const d = e.data as RpcMessage | null;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.method === "ui/initialize") {
      const tools = HOST_TOOLS.filter((t) => deps.needs.includes(TOOL_CAP[t.name])); // advertise only declared caps
      reply(d.id, {
        protocolVersion: PROTOCOL_VERSION,
        hostInfo: { name: "agentgem-console", version: "2" },
        hostCapabilities: { serverTools: {}, openLinks: {}, sandbox: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } },
        hostContext: deps.hostContext ? deps.hostContext() : {}, // PR 3 supplies hostContext(); PR 2 leaves {} via optional dep
        _meta: { "ai.agentgem/host": { tools } },
      });
      return;
    }
    if (d.method === "ui/notifications/initialized") return; // handshake ack — nothing to do
    if (d.method === "ui/request-display-mode") {
      // Spec: the host may refuse, so reply with the mode it ACTUALLY applied, not the requested one
      // (e.g. a thumbnail's onDisplayMode always refuses fullscreen).
      const req = (d.params as { mode?: string } | undefined)?.mode ?? "inline";
      const applied = deps.onDisplayMode ? deps.onDisplayMode(req) : "inline";
      reply(d.id, { mode: applied });
      return;
    }
    if (d.method === "tools/call") { void handleCall(d); return; }
    if (d.method === "mcp/call") { void handleMcpCall(d); return; }
    if (d.method === "mcp/list") { void handleMcpList(d); return; }
    if (d.method === "mcp/watch") { void handleWatch(d); return; }
    if (d.method === "mcp/unwatch") { handleUnwatch(d); return; }
    if (d.method === "ui/open-link") { void handleOpenLink(d); return; }
    if (d.method === "ui/copy-command") { void handleCopy(d); return; }
    if (d.method === "ui/message") { handleUnsupportedAction(d, "send-message"); return; }
    if (d.method === "ui/update-model-context") { handleUnsupportedAction(d, "update-model-context"); return; }
  }

  // Host-initiated rebind for the "Replay yours" picker (Runner's feedSession, PR D): the sealed
  // miniapp can't choose a session (see the AUTO session-data branch above), so the HOST calls this
  // directly with a viewer-picked sessionId/agent and pushes the result over the same notification
  // channel the shim's onNotification consumes, re-booting the game on that session.
  function feedSessionData(sessionId: string, agent: string): void {
    if (feeding) return;                               // one in-flight feed at a time
    feeding = true;
    const gen = generation;
    getSessionData(deps.apiBase, deps.name, { sessionId, agent })
      .then((data) => { if (!stale(gen)) notify(CAP_TOOL["session-data"], data); })
      .catch(() => { /* keep the current render */ })
      .finally(() => { feeding = false; });
  }

  // Host-initiated hygiene rebind (the Runner's session picker): the sealed miniapp can't choose which
  // session feeds its context-hygiene stream (execute() ignores miniapp-supplied args for the cap), so the
  // HOST calls this with a viewer-picked transcript file. Closes ONLY the current hygiene stream and opens
  // one on the chosen file; events flow over the same notification channel, so the game just re-renders.
  // The click on a specific session IS the viewer's consent — same posture as feedSessionData.
  function rebindHygiene(file: string): void {
    if (!deps.needs.includes("context-hygiene")) return;
    const gen = generation;
    if (hygieneHandle) { try { hygieneHandle.close(); } catch { /* ignore */ } handles.delete(hygieneHandle); hygieneHandle = null; }
    hygieneOpen = true;
    subscribeHygiene(deps.apiBase, (ev) => { if (!stale(gen)) notify(CAP_TOOL["context-hygiene"], ev); }, file)
      .then((r) => {
        if (r.status !== "subscribed") { hygieneOpen = false; return; }           // unreachable with an explicit file, but keep the guard honest
        if (stale(gen)) { try { r.handle.close(); } catch { /* ignore */ } hygieneOpen = false; return; }
        register(gen, r.handle);
        hygieneHandle = r.handle;
      })
      .catch(() => { hygieneOpen = false; });                                     // release so a later subscribe/rebind can succeed
  }

  function dispose(): void {
    for (const h of handles) { try { h.close(); } catch { /* ignore */ } }
    handles.clear();
  }

  // Pin a new generation: async continuations started before the bump no-op, and open streams close.
  // Also reset the single-flight guards (mirrors Runner's teardown on game change).
  function bumpGeneration(): void {
    generation++;
    dispose();
    liveOpen = false;
    hygieneOpen = false;
    hygieneHandle = null;
    invoking = false;
    chatId = null;
    chatPromise = null;
    feeding = false;
    mcpDigests.clear();
    // Teardown: cancel every watch's timer (so no orphaned poll ever fires against a torn-down game) and
    // drop the registry outright — the generation bump above already makes any in-flight poll's
    // continuation drop on resolve, this just stops NEW ones from ever being scheduled.
    for (const entry of watches.values()) {
      if (entry.cancelTimer) { try { entry.cancelTimer(); } catch { /* ignore */ } entry.cancelTimer = undefined; }
    }
    watches.clear();
    watchOwners.clear();
  }

  return { handleMessage, dispose, bumpGeneration, feedSessionData, rebindHygiene, pushHostContext, wakeWatches };
}
