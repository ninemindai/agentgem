// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/console/src/panels/_shared/resilientStream.ts
//
// EventSource with a stall watchdog and a polling fallback, for the Watch tab's
// live streams. A buffering proxy (corporate MITM, ALB response buffering) holds
// an SSE response open but delivers nothing — the browser sees a healthy
// connection and the panel stays empty forever. The server heartbeats a named
// `ping` event every 15s (an SSE `:` comment is invisible to EventSource), so:
// no named event within `watchdogMs` → the transport is dead or buffered → close
// it and poll the same route's `?poll=1` mode instead, which replies with the
// SAME discriminated messages as one JSON body plus a cursor.
//
// The `advance` fold keeps the cursor current while SSE is still healthy, so a
// mid-stream downgrade never re-delivers backlog. The downgrade is one-way and
// silent by design (onTransport is a hook, not a UI requirement): degraded
// beats broken, and the next mount retries SSE from scratch.

export interface PollResult<C> {
  messages: { event: string; data: unknown }[];
  cursor: C;
}

export interface ResilientStreamOptions<C> {
  /** SSE url (native EventSource). */
  streamUrl: string;
  /** Named SSE events to forward (`ping` is handled internally). */
  events: string[];
  /** Receives every delivered message, from either transport. */
  onMessage(event: string, data: unknown): void;
  /** Fold one SSE-delivered message into the poll cursor. */
  advance(cursor: C, event: string, data: unknown): C;
  /** One poll round-trip against the route's ?poll=1 mode. */
  poll(cursor: C): Promise<PollResult<C>>;
  initialCursor: C;
  /** Observability hook: fires once when the stream downgrades to polling. */
  onTransport?(mode: "poll"): void;
  /** No named event for this long → stalled (server pings every 15s). */
  watchdogMs?: number;
  pollMs?: number;
}

export function openResilientStream<C>(o: ResilientStreamOptions<C>): () => void {
  const WATCHDOG_MS = o.watchdogMs ?? 25_000;
  const POLL_MS = o.pollMs ?? 2_000;
  let closed = false;
  let cursor = o.initialCursor;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let es: EventSource | null = null;

  const close = () => {
    closed = true;
    clearTimeout(watchdog);
    clearTimeout(pollTimer);
    es?.close();
    es = null;
  };

  const startPolling = () => {
    if (closed) return;
    o.onTransport?.("poll");
    const tick = async () => {
      if (closed) return;
      let r: PollResult<C>;
      try { r = await o.poll(cursor); }
      catch {
        if (!closed) { o.onMessage("failed", { message: "connection lost" }); close(); }
        return;
      }
      if (closed) return;
      cursor = r.cursor;
      for (const m of r.messages) {
        o.onMessage(m.event, m.data);
        if (closed) return; // a terminal message may close us mid-batch
      }
      pollTimer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
  };

  const degrade = () => {
    if (closed || !es) return;
    clearTimeout(watchdog);
    es.close();
    es = null;
    startPolling();
  };

  const arm = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(degrade, WATCHDOG_MS);
  };

  es = new EventSource(o.streamUrl);
  arm();
  es.addEventListener("ping", arm);
  for (const event of o.events) {
    es.addEventListener(event, (m) => {
      if (closed) return;
      arm();
      const data: unknown = JSON.parse((m as MessageEvent).data);
      cursor = o.advance(cursor, event, data);
      o.onMessage(event, data);
    });
  }
  // EventSource "error" also fires on transient reconnects; treat it like a stall
  // and switch to polling — degraded beats the old terminal "connection lost".
  es.addEventListener("error", degrade);

  return close;
}
