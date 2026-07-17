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

// The MCP Apps extension's protocol revision this host implements (ext-apps MVP, 2026-01-26).
const PROTOCOL_VERSION = "2026-01-26";

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
}

export interface UiHost {
  handleMessage(e: MessageEvent): void;
  dispose(): void;
  bumpGeneration(): void;
  feedSessionData(sessionId: string, agent: string): void; // host-initiated "Replay yours" rebind
  rebindHygiene(file: string): void;                        // host-initiated hygiene-stream rebind (session picker)
  pushHostContext(partial: Record<string, unknown>): void;  // host-initiated host-context-changed push (fullscreen toggle)
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
  }

  return { handleMessage, dispose, bumpGeneration, feedSessionData, rebindHygiene, pushHostContext };
}
