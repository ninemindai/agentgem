// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The type-while-busy message queue shared by both chat composers (Play Studio, Chat tab) —
// extracted per the 2026-07-20 eng review (issue 2) so queue behavior evolves in ONE place.
//
//   composer busy?  ──yes──▶ push(text) ──▶ [chips: removable]
//        │                                       │
//        no                                      │ turn ends (stream onDone OR resume poll)
//        ▼                                       ▼
//      send(text)                     fire(): coalesce q.join("\n") ──▶ send() — ONE turn
//                                                │
//                              failed turn ──▶ HOLD (manual "Send queued" button)
//                              session kill ──▶ clear() (queued context died with the session)
//
// State renders the chips; the ref is the logic's copy so fire() never runs a send inside a
// state updater (StrictMode would double-fire). sendRef always points at the LATEST send so a
// fire() invoked from an old render's onDone closure cannot capture a stale session id.
import React, { useEffect, useRef, useState } from "react";

export interface MessageQueue {
  queued: string[];
  push(text: string): void;
  removeAt(i: number): void;
  /** Drop everything without sending — session-kill path (eng review issue 9: context purity). */
  clear(): void;
  /** Coalesce the queue into ONE send. No-op when empty. Safe from stale closures. */
  fire(): void;
}

export function useMessageQueue(send: (text: string) => void): MessageQueue {
  const [queued, setQueued] = useState<string[]>([]);
  const queuedRef = useRef<string[]>([]);
  const sendRef = useRef(send);
  useEffect(() => { sendRef.current = send; });
  // The trio below writes ref + state together, always.
  const push = (text: string) => { queuedRef.current = [...queuedRef.current, text]; setQueued(queuedRef.current); };
  const removeAt = (i: number) => { queuedRef.current = queuedRef.current.filter((_, j) => j !== i); setQueued(queuedRef.current); };
  const clear = () => { queuedRef.current = []; setQueued([]); };
  const fire = () => {
    const q = queuedRef.current;
    if (!q.length) return;
    queuedRef.current = [];
    setQueued([]);
    sendRef.current(q.join("\n"));
  };
  return { queued, push, removeAt, clear, fire };
}

/** The queued-message chips + the manual "Send queued" affordance (shown only when not busy —
 * the held-queue path after a failed turn). Renders nothing when the queue is empty. */
export function QueueChips({ queue, busy, fireButtonClassName = "play-btn", style }: {
  queue: MessageQueue; busy: boolean; fireButtonClassName?: string; style?: React.CSSProperties;
}) {
  if (queue.queued.length === 0) return null;
  return (
    <div className="studio-queue" style={style}>
      {queue.queued.map((q, i) => (
        <span key={`${i}:${q}`} className="studio-queue__chip" title="queued — sends when the agent finishes">
          <span className="studio-queue__text">{q}</span>
          <button aria-label={`remove queued message ${i + 1}`} onClick={() => queue.removeAt(i)}>✕</button>
        </span>
      ))}
      {!busy && <button type="button" className={fireButtonClassName} onClick={() => queue.fire()}>Send queued</button>}
    </div>
  );
}

/** POST the turn-interrupt and classify the outcome. fetch resolves on HTTP errors (eng review
 * issue 8 — the classic footgun), so callers branch on this result, never on throw-vs-return:
 *   "cancelled" — a cancel was sent; the stream's done (stopReason "cancelled") is the real feedback
 *   "noop"      — nothing to cancel (turn just finished, or this agent has no cancel support)
 *   "failed"    — route unreachable or HTTP error; caller should fall back (session-kill / error) */
export async function postCancel(apiBase: string, chatId: string): Promise<"cancelled" | "noop" | "failed"> {
  try {
    const res = await fetch(`${apiBase}/api/chat/${encodeURIComponent(chatId)}/cancel`, { method: "POST" });
    if (!res.ok) return "failed";
    const body = await res.json().catch(() => ({}));
    return body?.cancelled ? "cancelled" : "noop";
  } catch {
    return "failed";
  }
}
