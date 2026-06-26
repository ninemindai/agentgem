// src/gem/acpSession.ts
//
// The shared ACP adapter plumbing used by BOTH the workflow recommender and the
// Gem runner: spawn the adapter binary, bridge stdio via the SDK, build a session,
// set its mode, and pump session updates until the turn stops. The two callers
// differ only in permission policy (deny vs allow) and how they fold updates
// (text-only string vs structured RunResult), so those stay in the callers — this
// module owns the boilerplate that was previously copy-pasted between them.
//
// NEEDS LIVE VALIDATION: stdio bridging against the real ACP adapter (covered by
// the runner + recommender live smokes, since both now route through here).
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { Readable, Writable } from "node:stream";

// An ACP adapter to spawn: a display id/name plus the argv to launch it.
export interface AgentDescriptor { id: string; name: string; command: string[] }

// A live session over a connected adapter. `prompt` sends one turn and dispatches
// each session_update's `.update` payload to `onUpdate` until the turn stops.
export interface RawAcpSession {
  setMode(mode: string): Promise<void>;
  prompt(text: string, onUpdate: (update: unknown) => void): Promise<void>;
  dispose(): void;
}
export interface RawAcpConnection {
  open(cwd: string): Promise<RawAcpSession>;
  close(): void;
}

export interface ConnectAdapterOptions {
  clientName: string;
  // Auto-response to session/request_permission: "deny" cancels every request
  // (recommender, read-only); "allow" approves them (runner, tool-capable).
  permission: "allow" | "deny";
}

export async function connectAcpAdapter(
  descriptor: AgentDescriptor,
  opts: ConnectAdapterOptions,
): Promise<RawAcpConnection> {
  const { client, ndJsonStream, PROTOCOL_VERSION } = await import("@agentclientprotocol/sdk");
  const [bin, ...args] = descriptor.command;
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "inherit"], env: process.env });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (e) => reject(new Error(`failed to spawn ${bin}: ${e.message}`)));
  });
  const app: any = client({ name: opts.clientName });
  const reply = opts.permission === "allow"
    ? { outcome: { outcome: "selected", optionId: "allow" } }
    : { outcome: { outcome: "cancelled" } };
  app.onRequest?.("session/request_permission", async () => reply);
  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const connection: any = app.connect(ndJsonStream(output, input));
  const agentCtx: any = connection.agent;
  // ACP requires an `initialize` handshake before any session/new. claude-agent-acp
  // tolerated skipping it; codex-acp strictly rejects session/new with "Not
  // initialized" (-32603) without it. We advertise no client capabilities we don't
  // implement (no fs/terminal handlers) — both adapters write files directly.
  await agentCtx.request("initialize", { protocolVersion: PROTOCOL_VERSION });

  return {
    async open(cwd: string) {
      try { mkdirSync(cwd, { recursive: true }); } catch { /* best-effort */ }
      const session: any = await agentCtx.buildSession(cwd).start();
      const sessionId = session.sessionId as string;
      return {
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          void session.prompt(text);
          for (;;) {
            const msg: any = await session.nextUpdate();
            if (msg.kind === "stop") break;
            if (msg.kind === "session_update") onUpdate(msg.update);
          }
        },
        dispose() { try { session.dispose?.(); } catch { /* ignore */ } },
      };
    },
    close: () => {
      try { connection.close(); } catch { /* ignore */ }
      try { child.kill(); } catch { /* ignore */ }
    },
  };
}
