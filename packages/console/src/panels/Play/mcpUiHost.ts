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
import { AUTO_CAPS } from "./consent.js";
import {
  getSessionData, getInventory, subscribeSessions, openNeutralChat, invokeAgent,
  CAP_TOOL, TOOL_CAP, HOST_TOOLS, type StreamHandle,
} from "./mcpHostTools.js";

// The MCP Apps extension's protocol revision this host implements (ext-apps MVP, 2026-01-26).
const PROTOCOL_VERSION = "2026-01-26";

export interface UiHostDeps {
  apiBase: string;
  name: string;
  needs: string[];
  interactive: boolean;
  target: Window;                                    // the iframe.contentWindow: post target + e.source boundary
  requestConsent: (cap: string) => Promise<boolean>; // gated caps only; AUTO caps bypass. Runner owns the modal.
}

export interface UiHost {
  handleMessage(e: MessageEvent): void;
  dispose(): void;
  bumpGeneration(): void;
  feedSessionData(sessionId: string, agent: string): void; // host-initiated "Replay yours" rebind
}

interface RpcMessage { jsonrpc?: string; id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }

export function createUiHost(deps: UiHostDeps): UiHost {
  let generation = 0;                                // bumped per game; async continuations pin to their start value
  const handles = new Set<StreamHandle>();           // open streams to close on dispose / stale
  // Single-flight guards — the exact set Runner.serve() kept as refs.
  let liveOpen = false;                              // one live-session-events stream
  let invoking = false;                              // one invoke-agent turn at a time
  let chatId: string | null = null;                  // reused neutral chat session
  let chatPromise: Promise<string> | null = null;    // in-flight chat-open (serialize concurrent invokes)
  let feeding = false;                                // one in-flight feedSessionData at a time (mirrors Runner's feedingRef)

  const post = (msg: unknown) => deps.target.postMessage(msg, "*");
  const stale = (gen: number) => gen !== generation;
  const reply = (id: number | undefined, result: unknown) => { if (id != null) post({ jsonrpc: "2.0", id, result }); };
  const replyError = (id: number | undefined, code: number, message: string) => { if (id != null) post({ jsonrpc: "2.0", id, error: { code, message } }); };
  const notify = (toolName: string, chunk: unknown) => post({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { toolName, chunk } });
  const register = (gen: number, handle: StreamHandle) => {
    if (stale(gen)) { try { handle.close(); } catch { /* ignore */ } } else handles.add(handle);
  };

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
      if (cap === "invoke-agent") {
        const message = typeof args.message === "string" ? args.message : undefined;
        if (!message || invoking) { reply(id, { status: "busy" }); return; }   // each invoke carries a prompt; one turn at a time
        if (!chatId) {
          // Serialize chat-open so two fast invokes don't spawn two sessions (check-then-set race).
          if (!chatPromise) chatPromise = openNeutralChat(deps.apiBase);        // neutral (read-only) — no miniapp field
          chatId = await chatPromise;
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

  function handleMessage(e: MessageEvent): void {
    if (e.source !== deps.target) return;            // only our own sealed iframe — the security boundary
    const d = e.data as RpcMessage | null;
    if (!d || d.jsonrpc !== "2.0") return;
    if (d.method === "ui/initialize") {
      const tools = HOST_TOOLS.filter((t) => deps.needs.includes(TOOL_CAP[t.name])); // advertise only declared caps
      reply(d.id, { protocolVersion: PROTOCOL_VERSION, tools, hostContext: {} });
      return;
    }
    if (d.method === "ui/notifications/initialized") return; // handshake ack — nothing to do
    if (d.method === "tools/call") { void handleCall(d); return; }
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
    invoking = false;
    chatId = null;
    chatPromise = null;
    feeding = false;
  }

  return { handleMessage, dispose, bumpGeneration, feedSessionData };
}
