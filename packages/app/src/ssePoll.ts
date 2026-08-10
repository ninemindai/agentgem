// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/app/src/ssePoll.ts
//
// Shared bits for the watch SSE handlers' polling fallback. A buffering proxy
// (corporate MITM, ALB with response buffering) holds an SSE response open but
// delivers nothing, and an SSE comment heartbeat is invisible to EventSource —
// so the console can't even detect the stall. Two remedies, used together:
//
//   • heartbeats are a NAMED `ping` event (observable client-side; any listener
//     resets the console's watchdog), not a `:` comment;
//   • each handler answers `?poll=1` with a one-shot JSON body carrying the SAME
//     discriminated messages the SSE would have delivered plus an opaque cursor,
//     so the console's watchdog can fall back to polling without re-receiving
//     backlog. See packages/console/src/panels/_shared/resilientStream.ts.

export interface SseRes {
  writeHead(status: number, headers: Record<string, string>): void;
  write(chunk: string): void;
  end(): void;
}

export interface PollMessage {
  event: string;
  data: unknown;
}

export function wantsPoll(query: Record<string, unknown>): boolean {
  return query.poll === "1";
}

export function pollReply(res: SseRes, messages: PollMessage[], cursor: Record<string, unknown>): void {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache, no-transform" });
  res.write(JSON.stringify({ messages, cursor }));
  res.end();
}
