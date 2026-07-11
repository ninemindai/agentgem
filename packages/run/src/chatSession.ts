// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/run/src/chatSession.ts
//
// Long-lived chat session manager: opens one ACP session per chat and reuses it
// across turns (multi-turn). Injects a brief on the first turn only. Supports
// idle-sweep (closes sessions past idleMs) and LRU-eviction (closes the least-
// recently-used session when the live count exceeds maxLive).
//
// The connectFn seam mirrors acpRun/acpRecommender: tests inject a plain fake;
// production passes a real ACP adapter. No subprocess is spawned here.
import { AGENTS, type AgentDescriptor } from "@agentgem/base";
import type { ToolInvocation, RunResult } from "./acpRun.js";


export type ChatEvent =
  | { type: "phase"; phase: string }
  | { type: "delta"; text: string }
  | { type: "tool"; tool: ToolInvocation }
  | { type: "done"; result: RunResult }
  | { type: "failed"; error: string };

export interface ChatSessionHandle {
  sessionId: string;
  setMode(m: string): Promise<void>;
  prompt(
    text: string,
    onDelta?: (c: string) => void,
    onToolCall?: (t: ToolInvocation) => void,
  ): Promise<RunResult>;
  dispose(): void;
}

export interface ChatCtx {
  open(cwd: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle>;
}

// Per-connection options. `permission` controls tool-confirmation policy: neutral goldmine chat uses
// "deny" (read-only); the Play studio uses "allow" so the agent can edit the miniapp in its jailed cwd.
export interface ChatConnectOpts { permission?: "allow" | "deny" }
export type ChatConnectFn = (descriptor: AgentDescriptor, opts?: ChatConnectOpts) => Promise<{ ctx: ChatCtx; close: () => void }>;

interface LiveChat {
  agentId: string;
  sessionId: string;
  /** brief is injected on the first turn, then nulled so it's not repeated */
  brief: string | null;
  conn: { ctx: ChatCtx; close: () => void };
  handle: ChatSessionHandle;
  lastMs: number;
  /** Set while a turn is in flight; guards against a second concurrent turn and protects
   * this chat from idle-sweep and LRU-eviction while it's running. */
  running: boolean;
}

let counter = 0;

export class ChatManager {
  private live = new Map<string, LiveChat>();
  private connectFn: ChatConnectFn;
  private now: () => number;
  private idleMs: number;
  private maxLive: number;

  constructor(opts: {
    connectFn: ChatConnectFn;
    now?: () => number;
    idleMs?: number;
    maxLive?: number;
  }) {
    this.connectFn = opts.connectFn;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 15 * 60_000;
    this.maxLive = opts.maxLive ?? 3;
  }

  async openChat(input: {
    agentId: string;
    brief: string;
    mcpServers?: unknown[];
    /** Override for tests — skips AGENTS registry lookup */
    descriptor?: AgentDescriptor;
    cwd?: string;
    permission?: "allow" | "deny";   // tool-confirmation policy for this session (default from the connectFn)
  }): Promise<string> {
    // Evict LRU sessions until we're under the cap
    while (this.live.size >= this.maxLive) {
      if (!this.evictLru()) throw new Error("too many active sessions; stop one to start another");
    }

    // Resolve descriptor from the AGENTS registry; throw if not found (unless overridden)
    const descriptor: AgentDescriptor = input.descriptor
      ?? (() => {
        const found = AGENTS.find((a) => a.id === input.agentId);
        if (!found) throw new Error(`Unknown agentId: ${input.agentId}`);
        return found;
      })();

    const conn = await this.connectFn(descriptor, { permission: input.permission });
    let handle: ChatSessionHandle;
    try {
      handle = await conn.ctx.open(input.cwd ?? process.cwd(), { mcpServers: input.mcpServers });
    } catch (err) {
      try { conn.close(); } catch { /* ignore */ }
      throw err;
    }

    const chatId = `chat_${++counter}`;
    this.live.set(chatId, {
      agentId: input.agentId,
      sessionId: handle.sessionId,
      running: false,
      brief: input.brief,
      conn,
      handle,
      lastMs: this.now(),
    });
    return chatId;
  }

  async *sendMessage(chatId: string, message: string): AsyncGenerator<ChatEvent> {
    const chat = this.live.get(chatId);
    if (!chat) {
      yield { type: "failed", error: `unknown chat ${chatId}` };
      return;
    }
    if (chat.running) {
      yield { type: "failed", error: "a turn is already running for this chat" };
      return;
    }
    chat.running = true;
    try {
      chat.lastMs = this.now();

      // Inject the brief on the first turn only
      const prompt = chat.brief ? `${chat.brief}\n\n---\nUser: ${message}` : message;
      chat.brief = null;

      yield { type: "phase", phase: "running" };

      // Live streaming: bridge the prompt's push-callbacks to this generator so deltas/tools are yielded
      // AS they arrive, not buffered until the turn ends. Without this, a long turn shows only
      // "phase: running" until it completes — indistinguishable from a hang.
      const queue: ChatEvent[] = [];
      let wake: (() => void) | null = null;
      const bump = () => { if (wake) { wake(); wake = null; } };
      let settled = false;
      let result: Awaited<ReturnType<ChatSessionHandle["prompt"]>> | undefined;
      let error: Error | undefined;

      const running = chat.handle
        .prompt(
          prompt,
          (text) => { queue.push({ type: "delta", text }); bump(); },
          (tool) => { queue.push({ type: "tool", tool }); bump(); },
        )
        .then((r) => { result = r; })
        .catch((e) => { error = e as Error; })
        .finally(() => { settled = true; bump(); });

      while (true) {
        while (queue.length) yield queue.shift()!;
        if (settled) break;
        await new Promise<void>((res) => { wake = res; });
      }
      await running; // ensure the promise's finally has run

      if (error) { yield { type: "failed", error: error.message }; return; }
      chat.lastMs = this.now();
      yield { type: "done", result: result! };
    } finally {
      chat.running = false;
    }
  }

  closeChat(chatId: string): void {
    const chat = this.live.get(chatId);
    if (!chat) return;
    try { chat.handle.dispose(); } catch { /* ignore */ }
    try { chat.conn.close(); } catch { /* ignore */ }
    this.live.delete(chatId);
  }

  /** Liveness + identity for a chat, for client reconciliation after navigation/reload. */
  stateOf(chatId: string): { alive: true; running: boolean; sessionId: string; agent: string } | { alive: false } {
    const c = this.live.get(chatId);
    if (!c) return { alive: false };
    return { alive: true, running: c.running, sessionId: c.sessionId, agent: c.agentId };
  }

  sweepIdle(): void {
    const cutoff = this.now() - this.idleMs;
    for (const [id, c] of this.live) {
      if (!c.running && c.lastMs < cutoff) this.closeChat(id);
    }
  }

  private evictLru(): boolean {
    let oldest: string | null = null;
    let oldestMs = Infinity;
    for (const [id, c] of this.live) {
      if (c.running) continue;               // never evict an in-flight background turn
      if (c.lastMs < oldestMs) { oldestMs = c.lastMs; oldest = id; }
    }
    if (oldest) { this.closeChat(oldest); return true; }
    return false;
  }
}
