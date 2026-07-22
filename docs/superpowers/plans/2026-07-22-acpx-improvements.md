# ACP Integration Improvements (acpx-inspired) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden and extend agentgem's ACP integration with four patterns borrowed from openclaw/acpx: startup-failure evidence, graceful shutdown, capability negotiation, real `session/resume`/`session/load` resume, timeout salvage, error classification, and a unified turn façade.

**Architecture:** All protocol-level changes land in `packages/base/src/acpSession.ts` (the single spawn/transport module every ACP caller routes through). Session-lifecycle changes flow up through `packages/run/src/chatSession.ts` (ChatManager) and `packages/app/src/goldmine/chatRoutes.ts`. The final PR extracts the triplicated update-fold into a shared base module. Four sequential PRs; each branches off freshly-fetched `origin/main` after the previous one merges.

**Tech Stack:** TypeScript ESM, `@agentclientprotocol/sdk` (ndjson JSON-RPC over child stdio), vitest (runs compiled `dist/`), pnpm workspaces.

## Global Constraints

- **Worktree per session** (CLAUDE.md): `git fetch origin && git worktree add ../agentgem-worktrees/<task> -b <task> origin/main`. Never commit to `main`.
- **Integration = PR** gated by the single required check `test (24)`; merge with `gh pr merge --rebase --delete-branch` after `gh run watch <run-id> --exit-status`; the local branch-delete step will error (main is checked out in another worktree) — the remote merge still succeeds; verify each commit's content on `origin/main` afterwards.
- **One PR = one settled scope**: never push follow-on commits to a branch whose PR was handed over; new scope → new branch off fresh `origin/main`.
- **CI-gated tests live in root `src/__tests__/*.test.ts`** and import from `@agentgem/base` / `@agentgem/run`. Tests in `packages/*/src/__tests__/` (except `packages/app`) are NOT in the root vitest include and do NOT gate CI — do not put new tests there.
- **Tests run against compiled dist**: `pnpm test` = `tsc -b && vitest run`. Single file: `npx tsc -b && npx vitest run dist/__tests__/<name>.test.js`.
- **Full rebuild** = root `pnpm build` (`tsc -b && node scripts/build-console.mjs`) — after module renames/moves, clean stale dist (`find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete` plus removing the moved files' old `dist/` outputs) or vitest picks up stale compiled tests.
- **Style**: two-space indent, dense explanatory comments (match `acpSession.ts`), `.js` suffixes on relative ESM imports, no new dependencies.
- Commit author: Raymond Feng <raymond@ninemind.ai>. Commit-message style: `base(acp): <what>` / `run(chat): <what>` scope prefixes.
- The `@agentclientprotocol/sdk` facts this plan relies on (verified against `node_modules/@agentclientprotocol/sdk/dist`): `ClientApp.onNotification(method, handler)` exists; `InitializeResponse = { protocolVersion, agentCapabilities?, authMethods?, agentInfo? }`; `AgentCapabilities.loadSession?: boolean`; `AgentCapabilities.sessionCapabilities?.resume` is an object (`{}` = supported, omitted/null = not); `ResumeSessionRequest = { sessionId, cwd, mcpServers? }`; `LoadSessionRequest = { sessionId, cwd, mcpServers }` (mcpServers required); `PromptResponse = { stopReason }`; StopReason includes `"end_turn" | "cancelled"`.

---

# PR 1 — branch `acp1-hardening`: startup evidence + shutdown ladder + capability snapshot

All changes in `packages/base/src/acpSession.ts` + its export barrel; tests in root `src/__tests__/`.

### Task 1.1: Worktree + fake-adapter test fixture

**Files:**
- Create: `src/__tests__/fakeAcpAdapter.ts` (helper, not a `.test.ts` — vitest only collects `*.test.js`)

**Interfaces:**
- Produces: `writeFakeAdapter(dir: string): string` — writes a standalone Node script implementing a minimal ndjson JSON-RPC ACP agent and returns its absolute path. Modes (argv[2]): `"ok"`, `"crash-before-init"`, `"ignore-term"`. argv[3] (optional): a pidfile path the script writes its pid to.

- [ ] **Step 1: Create the worktree**

```bash
git fetch origin
git worktree add ../agentgem-worktrees/acp1-hardening -b acp1-hardening origin/main
cd ../agentgem-worktrees/acp1-hardening
pnpm install
```

- [ ] **Step 2: Write the fixture helper**

```typescript
// src/__tests__/fakeAcpAdapter.ts
// A minimal ndjson JSON-RPC "ACP agent" used by the acpSession integration tests.
// Spawned as `node <script> <mode> [pidfile]`. Modes:
//   ok               — answers initialize (advertising loadSession + session.resume),
//                      session/new, session/resume, session/prompt (one text chunk then
//                      end_turn); exits 0 when stdin ends (the graceful-shutdown path).
//   crash-before-init — writes to stderr and exits 7 before answering anything.
//   ignore-term      — like ok, but ignores SIGTERM and never exits on stdin end,
//                      forcing the SIGKILL rung of the shutdown ladder.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `
const readline = require("node:readline");
const mode = process.argv[2] || "ok";
if (process.argv[3]) require("node:fs").writeFileSync(process.argv[3], String(process.pid));
if (mode === "crash-before-init") { process.stderr.write("boom: adapter exploded\\n"); process.exit(7); }
if (mode === "ignore-term") { process.on("SIGTERM", () => {}); }
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: msg.params && msg.params.protocolVersion,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      agentInfo: { name: "fake-adapter", version: "1.0.0" },
    } });
  } else if (msg.method === "session/new") {
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-new-1" } });
  } else if (msg.method === "session/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  } else if (msg.method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: {
      sessionId: msg.params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello from fake" } },
    } });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
});
process.stdin.on("end", () => { if (mode !== "ignore-term") process.exit(0); });
`;

/** Write the fake adapter script into `dir` and return its absolute path. */
export function writeFakeAdapter(dir: string): string {
  const path = join(dir, "fake-acp-adapter.cjs");
  writeFileSync(path, SCRIPT);
  return path;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/fakeAcpAdapter.ts
git commit -m "test(acp): add fake ndjson ACP adapter fixture for session-level tests"
```

### Task 1.2: Bounded stderr tail + startup-failure evidence

**Files:**
- Modify: `packages/base/src/acpSession.ts` (stderr handler at :97-105, dead-promise block at :111-120, initialize at :130-134, `open()`'s `builder.start()` at :141)
- Test: `src/__tests__/acpSessionHardening.test.ts`

**Interfaces:**
- Produces: `boundedTail(prev: string, chunk: string, max?: number): string` (exported from `@agentgem/base`); `connectAcpAdapter` rejects with stderr evidence when the adapter dies before/during the handshake.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/acpSessionHardening.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcpAdapter, boundedTail, type AgentDescriptor } from "@agentgem/base";
import { writeFakeAdapter } from "./fakeAcpAdapter.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "agentgem-acp-test-"));
const adapterPath = writeFakeAdapter(fixtureDir);
const descriptor = (mode: string, pidfile?: string): AgentDescriptor => ({
  id: "fake", name: "Fake", command: [process.execPath, adapterPath, mode, ...(pidfile ? [pidfile] : [])],
});

describe("boundedTail", () => {
  it("appends within the cap", () => {
    expect(boundedTail("ab", "cd", 10)).toBe("abcd");
  });
  it("keeps only the LAST max chars when overflowing", () => {
    expect(boundedTail("abcdef", "ghij", 6)).toBe("efghij");
  });
});

describe("connectAcpAdapter startup evidence", () => {
  it("rejects with the stderr tail when the adapter dies before initialize", async () => {
    await expect(connectAcpAdapter(descriptor("crash-before-init"), { clientName: "t", permission: "deny" }))
      .rejects.toThrow(/boom: adapter exploded/);
  });
  it("connects to a healthy adapter", async () => {
    const conn = await connectAcpAdapter(descriptor("ok"), { clientName: "t", permission: "deny" });
    expect(conn).toBeTruthy();
    conn.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsc -b && npx vitest run dist/__tests__/acpSessionHardening.test.js`
Expected: FAIL — `boundedTail` is not exported (TS build error) — that IS the failing state; proceed.

- [ ] **Step 3: Implement in acpSession.ts**

Add the helper above `connectAcpAdapter`:

```typescript
// Rolling stderr evidence: keep only the LAST `max` chars so a chatty adapter can't
// grow memory, while the tail (where the fatal error lands) is always preserved.
// Borrowed from acpx's bounded startup-stderr capture.
export function boundedTail(prev: string, chunk: string, max = 4096): string {
  const joined = prev + chunk;
  return joined.length <= max ? joined : joined.slice(joined.length - max);
}
```

Inside `connectAcpAdapter`, thread the tail through the existing stderr handler and `markDead` (replacing the current stderr handler and dead-promise block):

```typescript
  // Capture the adapter's stderr rather than inheriting it (crash dumps must not
  // pollute server logs) AND keep a bounded rolling tail so a startup failure can
  // say WHY the adapter died instead of a generic exit code.
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderrTail = boundedTail(stderrTail, text);
    const trimmed = text.trimEnd();
    if (trimmed) acpLog.debug(`[${bin}] ${trimmed}`);
  });
```

```typescript
  const markDead = (e: Error) => {
    if (!died) {
      const tail = stderrTail.trim();
      died = tail ? new Error(`${e.message}\nadapter stderr: ${tail}`) : e;
      signalDead(died);
    }
  };
```

Race the handshake and session start against `dead` (an adapter that exits before answering otherwise leaves the request pending forever):

```typescript
  await Promise.race([agentCtx.request("initialize", { protocolVersion: PROTOCOL_VERSION }), dead]);
```

and in `open()`:

```typescript
      const session: any = await Promise.race([builder.start(), dead]);
```

Export from the barrel if `packages/base/src/index.ts` uses named re-exports (check with `grep -n "acpSession" packages/base/src/index.ts`; if it's `export * from "./acpSession.js"` nothing to do).

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsc -b && npx vitest run dist/__tests__/acpSessionHardening.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts src/__tests__/acpSessionHardening.test.ts
git commit -m "base(acp): bounded stderr tail + startup-failure evidence on adapter death"
```

### Task 1.3: Graceful shutdown ladder

**Files:**
- Modify: `packages/base/src/acpSession.ts` (`ConnectAdapterOptions` at :83-88, `close` at :166-169)
- Test: `src/__tests__/acpSessionHardening.test.ts` (extend)

**Interfaces:**
- Consumes: `writeFakeAdapter` pidfile mode from Task 1.1.
- Produces: `ConnectAdapterOptions.shutdown?: { termMs?: number; killMs?: number }`; `close()` runs stdin-end → SIGTERM → SIGKILL with unref'd timers.

- [ ] **Step 1: Write the failing tests** (append to `acpSessionHardening.test.ts`)

```typescript
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitForDeath = async (pid: number, ms: number) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !pidAlive(pid);
};

describe("connectAcpAdapter shutdown ladder", () => {
  it("a healthy adapter exits from stdin end alone", async () => {
    const pidfile = join(fixtureDir, `pid-ok-${Date.now()}`);
    const conn = await connectAcpAdapter(descriptor("ok", pidfile), { clientName: "t", permission: "deny" });
    const pid = Number(readFileSync(pidfile, "utf8"));
    conn.close();
    expect(await waitForDeath(pid, 5000)).toBe(true);
  });
  it("escalates to SIGKILL when the adapter ignores stdin end and SIGTERM", async () => {
    const pidfile = join(fixtureDir, `pid-stubborn-${Date.now()}`);
    const conn = await connectAcpAdapter(
      descriptor("ignore-term", pidfile),
      { clientName: "t", permission: "deny", shutdown: { termMs: 100, killMs: 100 } },
    );
    const pid = Number(readFileSync(pidfile, "utf8"));
    conn.close();
    expect(await waitForDeath(pid, 5000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsc -b && npx vitest run dist/__tests__/acpSessionHardening.test.js`
Expected: FAIL — `shutdown` is not a known option (TS error).

- [ ] **Step 3: Implement**

Extend the options interface:

```typescript
export interface ConnectAdapterOptions {
  clientName: string;
  // Auto-response to session/request_permission: "deny" cancels every request
  // (recommender, read-only); "allow" approves them (runner, tool-capable).
  permission: "allow" | "deny";
  // Shutdown ladder pacing (tests shrink these): stdin end → SIGTERM after termMs →
  // SIGKILL after another killMs. Defaults 1500/1000.
  shutdown?: { termMs?: number; killMs?: number };
}
```

Replace `close`:

```typescript
    close: () => {
      try { connection.close(); } catch { /* ignore */ }
      // Graceful shutdown ladder (borrowed from acpx): stdin end() is the cleanest
      // signal for a stdio ACP agent (EOF on its read loop) — most adapters exit on
      // it. SIGTERM catches ones that don't; SIGKILL catches ones that trap SIGTERM.
      // Timers are unref'd so a wedged adapter can't keep the server process alive.
      if (died || child.exitCode !== null) { try { child.kill("SIGKILL"); } catch { /* already gone */ } return; }
      const termMs = opts.shutdown?.termMs ?? 1500;
      const killMs = opts.shutdown?.killMs ?? 1000;
      try { child.stdin?.end(); } catch { /* ignore */ }
      const term = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* ignore */ } }, termMs);
      const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, termMs + killMs);
      (term as { unref?: () => void }).unref?.();
      (kill as { unref?: () => void }).unref?.();
      child.once("exit", () => { clearTimeout(term); clearTimeout(kill); });
    },
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx tsc -b && npx vitest run dist/__tests__/acpSessionHardening.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts src/__tests__/acpSessionHardening.test.ts
git commit -m "base(acp): graceful shutdown ladder — stdin end, SIGTERM, SIGKILL"
```

### Task 1.4: Capability snapshot from initialize

**Files:**
- Modify: `packages/base/src/acpSession.ts` (`RawAcpConnection` at :78-81, initialize call)
- Test: `src/__tests__/acpSessionHardening.test.ts` (extend)

**Interfaces:**
- Produces (used by PR 2):
  - `interface AcpAgentInfo { protocolVersion?: number; capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: object | null } } & Record<string, unknown>; agentName?: string }`
  - `RawAcpConnection.info: AcpAgentInfo`
  - `supportsLoadSession(info: AcpAgentInfo): boolean`
  - `supportsResumeSession(info: AcpAgentInfo): boolean`

- [ ] **Step 1: Write the failing tests** (append)

```typescript
import { supportsLoadSession, supportsResumeSession } from "@agentgem/base";

describe("capability snapshot", () => {
  it("captures the initialize response's capabilities and agent name", async () => {
    const conn = await connectAcpAdapter(descriptor("ok"), { clientName: "t", permission: "deny" });
    expect(conn.info.capabilities.loadSession).toBe(true);
    expect(conn.info.agentName).toBe("fake-adapter");
    expect(supportsLoadSession(conn.info)).toBe(true);
    expect(supportsResumeSession(conn.info)).toBe(true);
    conn.close();
  });
  it("helpers are false for empty capabilities", () => {
    const info = { capabilities: {} };
    expect(supportsLoadSession(info)).toBe(false);
    expect(supportsResumeSession(info)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — Run: `npx tsc -b && npx vitest run dist/__tests__/acpSessionHardening.test.js`. Expected: FAIL (no `info` property / missing exports).

- [ ] **Step 3: Implement**

```typescript
// What the agent told us at initialize: protocol version + advertised capabilities.
// Callers gate optional methods (session/load, session/resume) on this instead of
// probing-and-catching. Kept loose (Record) — the ACP capability surface is still
// growing and we only ever read specific keys.
export interface AcpAgentInfo {
  protocolVersion?: number;
  capabilities: { loadSession?: boolean; sessionCapabilities?: { resume?: object | null } } & Record<string, unknown>;
  agentName?: string;
}
// Omitted/null means "not supported"; `{}` means supported (ACP capability convention).
export function supportsLoadSession(info: AcpAgentInfo): boolean {
  return info.capabilities.loadSession === true;
}
export function supportsResumeSession(info: AcpAgentInfo): boolean {
  const r = info.capabilities.sessionCapabilities?.resume;
  return r !== undefined && r !== null;
}
```

`RawAcpConnection` gains the field:

```typescript
export interface RawAcpConnection {
  info: AcpAgentInfo;
  open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  close(): void;
}
```

Capture at initialize (replacing the bare `await`):

```typescript
  const init: any = await Promise.race([agentCtx.request("initialize", { protocolVersion: PROTOCOL_VERSION }), dead]);
  const info: AcpAgentInfo = {
    protocolVersion: init?.protocolVersion,
    capabilities: (init?.agentCapabilities ?? {}) as AcpAgentInfo["capabilities"],
    agentName: init?.agentInfo?.name,
  };
  acpLog.debug(`[${bin}] initialized: protocol=${info.protocolVersion} agent=${info.agentName ?? "?"} loadSession=${supportsLoadSession(info)} resume=${supportsResumeSession(info)}`);
```

and include `info` in the returned object.

- [ ] **Step 4: Run tests** — Expected: PASS (8 tests). Then run the full suite: `pnpm test`. Expected: green (pre-existing failures, if any, noted and reported — not silently absorbed).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts src/__tests__/acpSessionHardening.test.ts
git commit -m "base(acp): capture agent capability snapshot at initialize"
```

### Task 1.5: PR 1 integration

- [ ] **Step 1**: `pnpm build && pnpm test` at repo root of the worktree. Expected: clean build, tests green.
- [ ] **Step 2**: `git push -u origin acp1-hardening` then `gh pr create --title "base(acp): startup evidence, shutdown ladder, capability snapshot" --body "$(cat <<'EOF'
Borrows three hardening patterns from openclaw/acpx into the shared ACP plumbing:
- Bounded (4KB) rolling stderr tail surfaced in the error when an adapter dies before/mid-handshake
- Graceful shutdown ladder on close(): stdin end → SIGTERM → SIGKILL, timers unref'd
- Capability snapshot from the initialize response (`conn.info`), with `supportsLoadSession`/`supportsResumeSession` helpers gating the resume work in the follow-up PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"`
- [ ] **Step 3**: `gh run watch <run-id> --exit-status` → `gh pr merge --rebase --delete-branch` (expect the local-delete error; verify with `git fetch && git log origin/main --oneline -5` that all three commits' content landed: `git show origin/main:packages/base/src/acpSession.ts | grep -c "boundedTail\|shutdown\|AcpAgentInfo"` > 0 for each marker).
- [ ] **Step 4**: `git worktree remove ../agentgem-worktrees/acp1-hardening`

---

# PR 2 — branch `acp2-resume`: real session resume with guarded fallback

Depends on PR 1 (`conn.info`, capability helpers). Branch off fresh `origin/main` after PR 1 merges.

### Task 2.1: `openExisting` on the raw connection

**Files:**
- Modify: `packages/base/src/acpSession.ts`
- Test: `src/__tests__/acpResume.test.ts`

**Interfaces:**
- Consumes: `AcpAgentInfo`, `supportsLoadSession`, `supportsResumeSession` (PR 1).
- Produces: `RawAcpConnection.openExisting(cwd: string, sessionId: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>` — resumes via `session/resume` when advertised, else `session/load` (replay updates dropped), else throws an error with `code: "resume_unsupported"`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/acpResume.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcpAdapter, type AgentDescriptor } from "@agentgem/base";
import { writeFakeAdapter } from "./fakeAcpAdapter.js";

const fixtureDir = mkdtempSync(join(tmpdir(), "agentgem-acp-resume-"));
const adapterPath = writeFakeAdapter(fixtureDir);
const descriptor: AgentDescriptor = { id: "fake", name: "Fake", command: [process.execPath, adapterPath, "ok"] };

describe("openExisting", () => {
  it("resumes a session via session/resume and prompts on it", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    const session = await conn.openExisting(fixtureDir, "sess-prior-42");
    expect(session.sessionId).toBe("sess-prior-42");
    let text = "";
    const stop = await session.prompt("continue", (u) => {
      const up = u as { sessionUpdate?: string; content?: { type?: string; text?: string } };
      if (up?.sessionUpdate === "agent_message_chunk" && up.content?.type === "text") text += up.content.text;
    });
    expect(stop).toBe("end_turn");
    expect(text).toBe("hello from fake");
    conn.close();
  });
  it("throws resume_unsupported when the agent advertises neither method", async () => {
    const conn = await connectAcpAdapter(descriptor, { clientName: "t", permission: "deny" });
    (conn.info.capabilities as Record<string, unknown>).loadSession = false;
    (conn.info.capabilities as Record<string, unknown>).sessionCapabilities = {};
    await expect(conn.openExisting(fixtureDir, "sess-x")).rejects.toMatchObject({ code: "resume_unsupported" });
    conn.close();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx tsc -b && npx vitest run dist/__tests__/acpResume.test.js`. Expected: FAIL (`openExisting` missing).

- [ ] **Step 3: Implement in acpSession.ts**

Register an app-level `session/update` dispatcher for externally-attached sessions BEFORE `app.connect(...)` (SDK `ActiveSession` routing only exists for `buildSession`-created sessions; resumed sessions need our own). Insert right after the `session/request_permission` handler:

```typescript
  // Update routing for sessions attached via session/resume or session/load — the
  // SDK's ActiveSession queue only wraps session/new. One connection-level handler
  // dispatches by sessionId; a session with no registered handler (e.g. the history
  // replay session/load streams before its first prompt) is deliberately dropped —
  // the console restores display history from the transcript instead.
  const externalUpdates = new Map<string, (update: unknown) => void>();
  app.onNotification?.("session/update", (params: any) => {
    const sid = params?.sessionId as string | undefined;
    if (sid) externalUpdates.get(sid)?.(params.update);
  });
```

Add `openExisting` beside `open` in the returned object (both share the `died`/`dead` machinery):

```typescript
    async openExisting(cwd: string, sessionId: string, opts?: { mcpServers?: McpServer[] }) {
      if (died) throw died;
      // Capability-gated ladder (acpx): session/resume (no history replay — cheapest)
      // → session/load (agent replays history; we drop it, transcript restore already
      // rendered it) → typed refusal the caller can fall back on.
      if (supportsResumeSession(info)) {
        await Promise.race([agentCtx.request("session/resume", { sessionId, cwd, mcpServers: opts?.mcpServers ?? [] }), dead]);
      } else if (supportsLoadSession(info)) {
        await Promise.race([agentCtx.request("session/load", { sessionId, cwd, mcpServers: opts?.mcpServers ?? [] }), dead]);
      } else {
        throw Object.assign(new Error(`${descriptor.id} supports neither session/resume nor session/load`), { code: "resume_unsupported" });
      }
      return {
        sessionId,
        async setMode(mode: string) {
          try { await agentCtx.request("session/set_mode", { sessionId, modeId: mode }); } catch { /* best-effort */ }
        },
        async prompt(text: string, onUpdate: (update: unknown) => void) {
          if (died) throw died;
          externalUpdates.set(sessionId, onUpdate);
          try {
            const resp: any = await Promise.race([
              agentCtx.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
              dead,
            ]);
            return resp?.stopReason as string | undefined;
          } finally {
            externalUpdates.delete(sessionId);
          }
        },
        cancel() {
          void agentCtx.notify("session/cancel", { sessionId }).catch(() => {});
        },
        dispose() { externalUpdates.delete(sessionId); },
      };
    },
```

Add the method to `RawAcpConnection`:

```typescript
export interface RawAcpConnection {
  info: AcpAgentInfo;
  open(cwd: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  /** Attach to a previously-created session (session/resume, else session/load).
   * Throws { code: "resume_unsupported" } when the agent advertises neither. */
  openExisting(cwd: string, sessionId: string, opts?: { mcpServers?: McpServer[] }): Promise<RawAcpSession>;
  close(): void;
}
```

- [ ] **Step 4: Run tests** — Expected: PASS. Also re-run `dist/__tests__/acpSessionHardening.test.js` (still green).

- [ ] **Step 5: Commit**

```bash
git add packages/base/src/acpSession.ts src/__tests__/acpResume.test.ts
git commit -m "base(acp): openExisting — capability-gated session/resume + session/load"
```

### Task 2.2: ChatManager guarded resume

**Files:**
- Modify: `packages/run/src/chatSession.ts`
- Test: `src/__tests__/acpResume.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new from base (works through the `ChatCtx` seam).
- Produces: `ChatCtx.openExisting?(cwd, sessionId, opts): Promise<ChatSessionHandle>`; `ChatManager.openChat` input gains `resumeSessionId?: string`; `stateOf()` gains `resumed: boolean` on the alive branch.

- [ ] **Step 1: Write the failing tests** (append to `acpResume.test.ts`)

```typescript
import { ChatManager, type ChatCtx, type ChatSessionHandle } from "@agentgem/run";

const mkHandle = (sessionId: string): ChatSessionHandle => ({
  sessionId,
  setMode: async () => {},
  prompt: async (text) => ({ text: `echo:${text}`, toolCalls: [] }),
  dispose: () => {},
});

describe("ChatManager resume", () => {
  it("resumes via openExisting: no brief injection, resumed=true, same sessionId", async () => {
    const prompts: string[] = [];
    const ctx: ChatCtx & { openExisting?: (cwd: string, sid: string) => Promise<ChatSessionHandle> } = {
      open: async () => { throw new Error("must not open a fresh session"); },
      openExisting: async (_cwd, sid) => {
        const h = mkHandle(sid);
        return { ...h, prompt: async (text) => { prompts.push(text); return { text: "ok", toolCalls: [] }; } };
      },
    };
    const mgr = new ChatManager({ connectFn: async () => ({ ctx, close: () => {} }) });
    const chatId = await mgr.openChat({ agentId: "fake", brief: "BRIEF", descriptor: { id: "f", name: "F", command: ["x"] }, resumeSessionId: "sess-old" });
    const st = mgr.stateOf(chatId);
    expect(st).toMatchObject({ alive: true, sessionId: "sess-old", resumed: true });
    for await (const _ of mgr.sendMessage(chatId, "hi")) { /* drain */ }
    expect(prompts).toEqual(["hi"]); // resumed session already has its context — no brief re-injection
  });
  it("falls back to a fresh session when openExisting fails, and injects the brief", async () => {
    const prompts: string[] = [];
    const ctx: ChatCtx & { openExisting?: (cwd: string, sid: string) => Promise<ChatSessionHandle> } = {
      open: async () => ({ ...mkHandle("sess-fresh"), prompt: async (text) => { prompts.push(text); return { text: "ok", toolCalls: [] }; } }),
      openExisting: async () => { throw Object.assign(new Error("nope"), { code: "resume_unsupported" }); },
    };
    const mgr = new ChatManager({ connectFn: async () => ({ ctx, close: () => {} }) });
    const chatId = await mgr.openChat({ agentId: "fake", brief: "BRIEF", descriptor: { id: "f", name: "F", command: ["x"] }, resumeSessionId: "sess-old" });
    expect(mgr.stateOf(chatId)).toMatchObject({ alive: true, sessionId: "sess-fresh", resumed: false });
    for await (const _ of mgr.sendMessage(chatId, "hi")) { /* drain */ }
    expect(prompts[0].startsWith("BRIEF")).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (`resumeSessionId`/`resumed` unknown).

- [ ] **Step 3: Implement in chatSession.ts**

`ChatCtx` gains the optional method:

```typescript
export interface ChatCtx {
  open(cwd: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle>;
  /** Attach to a prior ACP session (session/resume / session/load). Optional: fakes and
   * pre-resume adapters omit it; ChatManager falls back to open() on absence OR failure. */
  openExisting?(cwd: string, sessionId: string, opts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle>;
}
```

`LiveChat` gains `resumed: boolean`. In `openChat`, replace the single `conn.ctx.open(...)` call (keeping the existing try/close-on-throw structure):

```typescript
    const conn = await this.connectFn(descriptor, { permission: input.permission });
    let handle: ChatSessionHandle | undefined;
    let resumed = false;
    // Guarded resume ladder: reattaching to the prior session restores the agent's
    // in-context memory. ANY failure falls back to a fresh session — for us that is
    // exactly the previously-shipped behavior (display history comes from the
    // transcript restore), so fallback is safe; we surface `resumed` honestly in
    // stateOf() rather than pretending. (acpx's stricter never-discard rule protects
    // agent-side history we don't lose here.)
    if (input.resumeSessionId && conn.ctx.openExisting) {
      try {
        handle = await conn.ctx.openExisting(input.cwd ?? process.cwd(), input.resumeSessionId, { mcpServers: input.mcpServers });
        resumed = true;
      } catch { handle = undefined; }
    }
    try {
      handle ??= await conn.ctx.open(input.cwd ?? process.cwd(), { mcpServers: input.mcpServers });
    } catch (err) {
      try { conn.close(); } catch { /* ignore */ }
      throw err;
    }
```

and store `resumed` + skip the brief on resume:

```typescript
    this.live.set(chatId, {
      agentId: input.agentId,
      sessionId: handle.sessionId,
      running: false,
      resumed,
      // A resumed session already holds its original brief in-context — re-injecting
      // it would duplicate instructions and burn tokens.
      brief: resumed ? null : input.brief,
      conn,
      handle,
      lastMs: this.now(),
    });
```

`openChat`'s input type gains `resumeSessionId?: string`. `stateOf()`'s alive branch adds `resumed: c.resumed`.

- [ ] **Step 4: Run tests** — `npx tsc -b && npx vitest run dist/__tests__/acpResume.test.js`. Expected: PASS. Run `pnpm test` (chatStudio + gemRunStream suites must stay green).

- [ ] **Step 5: Commit**

```bash
git add packages/run/src/chatSession.ts src/__tests__/acpResume.test.ts
git commit -m "run(chat): guarded session resume in ChatManager — resume or fall back fresh"
```

### Task 2.3: Route + connectFn + Studio wiring

**Files:**
- Modify: `packages/app/src/goldmine/chatRoutes.ts` (`studioChatArgs` :78-108, POST /api/chat handler :165-186, `makeChatConnectFn` :335-360)
- Modify: `packages/console/src/panels/Play/Studio.tsx` (the ensure-chat POST at :314-316)
- Test: `src/__tests__/acpResume.test.ts` (extend — pure `studioChatArgs` test)

**Interfaces:**
- Consumes: `RawAcpConnection.openExisting` (2.1), `openChat({ resumeSessionId })` + `stateOf().resumed` (2.2).
- Produces: `POST /api/chat` accepts `resume?: string` (a sessionId) and returns `{ chatId, sessionId, agent, resumed }`.

- [ ] **Step 1: Write the failing test** (append)

```typescript
import { studioChatArgs } from "@agentgem/app/goldmine/chatRoutes";

describe("studioChatArgs resume passthrough", () => {
  it("threads body.resume through as resumeSessionId", async () => {
    const args = await studioChatArgs(
      { agentId: "claude-code", resume: "sess-9" },
      { buildBrief: async () => "B", goldmineMcp: () => [], neutralCwd: "/tmp/neutral" },
    );
    expect(args.resumeSessionId).toBe("sess-9");
  });
  it("omits resumeSessionId when body.resume is absent or not a string", async () => {
    const args = await studioChatArgs(
      { agentId: "claude-code", resume: 42 as unknown },
      { buildBrief: async () => "B", goldmineMcp: () => [], neutralCwd: "/tmp/neutral" },
    );
    expect(args.resumeSessionId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (unknown `resume` key / missing `resumeSessionId`).

- [ ] **Step 3: Implement**

`studioChatArgs`: widen the body type to `{ agentId?: unknown; miniapp?: unknown; project?: unknown; resume?: unknown }`, the return type to include `resumeSessionId?: string`, and at the top:

```typescript
  // SECURITY: `resume` is a client-supplied ACP sessionId. It never touches the fs —
  // the adapter resolves it in its OWN session store, and the ACP spec requires the
  // request cwd to match the session's cwd, so a sessionId from another project
  // fails at the adapter rather than attaching to the wrong workspace. Worst case
  // equals a failed resume → fresh session.
  const resumeSessionId = typeof body?.resume === "string" && body.resume ? body.resume : undefined;
```

and spread `...(resumeSessionId ? { resumeSessionId } : {})` into each of the three return objects.

POST /api/chat response gains the flag (replace the `res.json` at :176):

```typescript
      const st = deps.manager.stateOf(chatId);
      res.json({ chatId, sessionId: st.alive ? st.sessionId : "", agent: args.agentId, resumed: st.alive ? st.resumed : false });
```

`makeChatConnectFn`'s ctx gains `openExisting` mirroring `open` (insert after the `open` method):

```typescript
      async openExisting(cwd: string, sessionId: string, openOpts?: { mcpServers?: unknown[] }): Promise<ChatSessionHandle> {
        const session = await raw.openExisting(cwd, sessionId, { mcpServers: openOpts?.mcpServers as never });
        return {
          sessionId: session.sessionId,
          setMode: (m: string) => session.setMode(m),
          async prompt(text: string, onDelta?: (c: string) => void, onToolCall?: (t: ToolInvocation) => void) {
            const acc = createAccumulator();
            const stopReason = await session.prompt(text, (u) =>
              applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], { onDelta, onToolCall }),
            );
            return { ...acc, stopReason };
          },
          cancel: () => session.cancel(),
          dispose: () => session.dispose(),
        };
      },
```

Studio.tsx ensure-chat POST (line 314): include the stored sessionId so a reload-continue reattaches:

```typescript
        const stored = getStudioChat(name);
        const res = await fetch(`${apiBase}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, miniapp: name, ...(stored?.sessionId ? { resume: stored.sessionId } : {}) }) }).then(j);
```

(`getStudioChat` is already imported in Studio.tsx — verify with grep; if not, add it to the existing `./studioChatStore.js` import.)

- [ ] **Step 4: Verify**

Run: `pnpm test` — all green, including the new passthrough tests.
Console tests are NOT in CI (memory: ci-skips-console-tests) — run locally: `cd packages/console && pnpm test`. Expected: green.

- [ ] **Step 5: Live smoke (required — resume touches a real adapter)**

Use the repo's `verify` skill flow: build + launch the console, open a Studio chat on a test miniapp, send a message, reload the page, send another message, and confirm on the server log that the second turn reused the SAME ACP sessionId (resumed) rather than minting a new one. If `claude-agent-acp@0.51.0` advertises neither resume capability, confirm the fallback path produces exactly today's behavior (fresh session, history rendered) and note the finding in the PR body.

- [ ] **Step 6: Commit + PR**

```bash
git add packages/app/src/goldmine/chatRoutes.ts packages/console/src/panels/Play/Studio.tsx src/__tests__/acpResume.test.ts
git commit -m "app(chat)+console(studio): thread session resume through POST /api/chat"
git push -u origin acp2-resume
gh pr create --title "ACP session resume: reattach Studio chats to their prior session" --body "..."
```

Then the standard merge ritual (watch CI, rebase-merge, verify every commit's content on origin/main — this is a multi-commit PR, the dropped-commit trap applies).

---

# PR 3 — branch `acp3-errors`: error normalization + timeout salvage

### Task 3.1: `normalizeAcpError`

**Files:**
- Create: `packages/base/src/acpErrors.ts`
- Modify: `packages/base/src/index.ts` (re-export; match the barrel's existing style)
- Test: `src/__tests__/acpErrors.test.ts`

**Interfaces:**
- Produces: `type AcpErrorKind = "auth" | "protocol" | "crash" | "timeout" | "unknown"`; `interface NormalizedAcpError { kind: AcpErrorKind; retryable: boolean; code?: number; message: string }`; `normalizeAcpError(err: unknown): NormalizedAcpError`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/acpErrors.test.ts
import { describe, it, expect } from "vitest";
import { normalizeAcpError } from "@agentgem/base";

const rpc = (code: number, message = "x", data?: unknown) => Object.assign(new Error(message), { code, data });

describe("normalizeAcpError", () => {
  it("classifies -32603 and -32700 as retryable protocol errors", () => {
    expect(normalizeAcpError(rpc(-32603))).toMatchObject({ kind: "protocol", retryable: true, code: -32603 });
    expect(normalizeAcpError(rpc(-32700))).toMatchObject({ kind: "protocol", retryable: true });
  });
  it("classifies method/param errors as permanent", () => {
    for (const code of [-32601, -32602, -32001, -32002]) {
      expect(normalizeAcpError(rpc(code))).toMatchObject({ kind: "protocol", retryable: false, code });
    }
  });
  it("detects auth-required as permanent auth", () => {
    expect(normalizeAcpError(rpc(-32000, "authentication required"))).toMatchObject({ kind: "auth", retryable: false });
    expect(normalizeAcpError(rpc(-32000, "x", { authRequired: true }))).toMatchObject({ kind: "auth", retryable: false });
  });
  it("classifies process death as a non-retryable crash", () => {
    expect(normalizeAcpError(new Error("agent process exited (code 1, signal null)"))).toMatchObject({ kind: "crash", retryable: false });
    expect(normalizeAcpError(new Error("agent process error: spawn ENOENT"))).toMatchObject({ kind: "crash", retryable: false });
  });
  it("classifies timeouts and unknowns as non-retryable", () => {
    expect(normalizeAcpError(new Error("agent run timed out after 300000ms"))).toMatchObject({ kind: "timeout", retryable: false });
    expect(normalizeAcpError("weird")).toMatchObject({ kind: "unknown", retryable: false });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx tsc -b` fails on the missing export. Expected.

- [ ] **Step 3: Implement**

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/acpErrors.ts
//
// Uniform classification of ACP failures, borrowed from acpx's error strategy:
// JSON-RPC -32603 (internal — usually a wrapped model-API failure) and -32700
// (parse) are worth retrying; method/param/auth errors are permanent; a dead
// adapter process is never retryable at the prompt level (the connection is gone).
// Callers use `kind` for messaging and `retryable` for policy — no retry loop
// lives here (YAGNI until a caller wants one).

export type AcpErrorKind = "auth" | "protocol" | "crash" | "timeout" | "unknown";

export interface NormalizedAcpError {
  kind: AcpErrorKind;
  retryable: boolean;
  code?: number;
  message: string;
}

const RETRYABLE_RPC = new Set([-32603, -32700]);
const PERMANENT_RPC = new Set([-32601, -32602, -32001, -32002]);
const AUTH_HINT = /auth(entication|orization)? required|not (?:logged|signed) in|login required/i;

export function normalizeAcpError(err: unknown): NormalizedAcpError {
  const e = err as { message?: string; code?: unknown; data?: { authRequired?: unknown } } | null;
  const message = typeof e?.message === "string" ? e.message : String(err);
  const code = typeof e?.code === "number" ? e.code : undefined;
  if (code !== undefined) {
    if (e?.data?.authRequired === true || AUTH_HINT.test(message)) return { kind: "auth", retryable: false, code, message };
    if (RETRYABLE_RPC.has(code)) return { kind: "protocol", retryable: true, code, message };
    if (PERMANENT_RPC.has(code)) return { kind: "protocol", retryable: false, code, message };
    return { kind: "protocol", retryable: false, code, message };
  }
  if (/^agent process (exited|error)/.test(message)) return { kind: "crash", retryable: false, message };
  if (/timed? ?out/i.test(message)) return { kind: "timeout", retryable: false, message };
  return { kind: "unknown", retryable: false, message };
}
```

Re-export from `packages/base/src/index.ts` following its existing pattern for `acpSession.js`.

- [ ] **Step 4: Run tests** — PASS expected.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "base(acp): normalizeAcpError — uniform retryable/kind classification"`

### Task 3.2: Timeout salvage in the Gem runner

**Files:**
- Modify: `packages/run/src/acpRun.ts` (`GemRunOutcome` :123-128, `runGemWithAgent` :173-196)
- Test: `src/__tests__/acpRunSalvage.test.ts`

**Interfaces:**
- Consumes: `normalizeAcpError` (3.1).
- Produces: `GemRunOutcome.salvaged?: boolean`; `GemRunOutcome.errorKind?: AcpErrorKind`. On timeout with agent text already streamed, the run returns `ok: true, salvaged: true` instead of failing.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/acpRunSalvage.test.ts
import { describe, it, expect } from "vitest";
import { runGemWithAgent, type RunConnectFn } from "@agentgem/run";

// A fake agent whose prompt streams a reply but never resolves the RPC — the
// acpx-documented adapter bug the salvage exists for.
const streamThenHang: RunConnectFn = async () => ({
  ctx: {
    open: async () => ({
      setMode: async () => {},
      prompt: (_text, onDelta, onToolCall) => {
        onDelta?.("the actual answer");
        onToolCall?.({ toolCallId: "t1", title: "Read", status: "completed" });
        return new Promise(() => {}); // never resolves
      },
      dispose: () => {},
    }),
  },
  close: () => {},
});

const silentHang: RunConnectFn = async () => ({
  ctx: { open: async () => ({ setMode: async () => {}, prompt: () => new Promise(() => {}), dispose: () => {} }) },
  close: () => {},
});

describe("runGemWithAgent timeout salvage", () => {
  it("salvages a timed-out turn whose reply already streamed", async () => {
    const out = await runGemWithAgent({ dir: "/tmp", task: "t", connectFn: streamThenHang, timeoutMs: 100 });
    expect(out.ok).toBe(true);
    expect(out.salvaged).toBe(true);
    expect(out.result.text).toBe("the actual answer");
    expect(out.result.toolCalls).toHaveLength(1);
  });
  it("still fails a timeout with no output, with errorKind timeout", async () => {
    const out = await runGemWithAgent({ dir: "/tmp", task: "t", connectFn: silentHang, timeoutMs: 100 });
    expect(out.ok).toBe(false);
    expect(out.salvaged).toBeUndefined();
    expect(out.errorKind).toBe("timeout");
  });
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (`salvaged`/`errorKind` missing; first case returns ok:false).

- [ ] **Step 3: Implement**

`GemRunOutcome` gains the fields:

```typescript
export interface GemRunOutcome {
  ok: boolean;
  result: RunResult;
  error?: string;
  /** Classification of `error` (normalizeAcpError), present on failure. */
  errorKind?: AcpErrorKind;
  /** True when the prompt RPC timed out but the agent's reply had already streamed —
   * the result is trusted evidence (acpx's "session shows a reply" salvage). */
  salvaged?: boolean;
  sandbox: { backend: string; isolated: boolean };
}
```

(add `import { normalizeAcpError, type AcpErrorKind } from "@agentgem/base";` to the existing base import line.)

In `runGemWithAgent`, mirror the stream into a local accumulator by wrapping the caller's handlers (the tool objects are shared by reference with the connectFn's own accumulator, so later `tool_call_update` status merges are visible here too):

```typescript
  // Salvage mirror: everything the agent streams also lands here, so a timed-out
  // RPC whose answer already arrived can be returned instead of discarded. Tool
  // entries are the same object references applyUpdate mutates on status updates,
  // so final statuses propagate into the mirror for free.
  const mirror = createAccumulator();
  const onDelta = (c: string) => { mirror.text += c; opts.onDelta?.(c); };
  const onToolCall = (t: ToolInvocation) => { mirror.toolCalls.push(t); opts.onToolCall?.(t); };
```

pass `onDelta, onToolCall` to `handle.prompt(...)` instead of `opts.onDelta, opts.onToolCall`, and replace the catch block:

```typescript
  } catch (err) {
    const norm = normalizeAcpError(err);
    if (norm.kind === "timeout" && mirror.text) {
      log.warn("acp run: prompt RPC timed out after reply streamed — salvaging %d chars", mirror.text.length);
      return { ok: true, result: { ...mirror, stopReason: "end_turn" }, salvaged: true, sandbox };
    }
    return { ok: false, result: { text: "", toolCalls: [] }, error: norm.message, errorKind: norm.kind, sandbox };
  }
```

- [ ] **Step 4: Run tests** — new file PASS; `pnpm test` green (gemRunStream + verify suites unaffected — `ok`/`result`/`error` semantics unchanged on all existing paths).
- [ ] **Step 5: Commit + PR** — `git commit -m "run(acp): salvage timed-out turns whose reply already streamed; classify errors"`, push, PR titled "ACP error classification + timeout salvage", standard merge ritual.

---

# PR 4 — branch `acp4-turn-api`: unify the triplicated ACP façades

Pays down the debt documented at `acpRun.ts:19-21`. The update-fold (`createAccumulator`/`applyUpdate`) moves to base; a shared `promptRun` replaces the three hand-rolled copies in `connectRunSession` (acpRun), `makeChatConnectFn` (chatRoutes), and `defaultConnectFn` (acpRecommender).

### Task 4.1: Move the update reducer to base

**Files:**
- Create: `packages/base/src/acpUpdates.ts` (verbatim move of `ToolInvocation`, `RunResult`, `RunAccumulator`, `createAccumulator`, `UpdateLike`, `applyUpdate` from `packages/run/src/acpRun.ts:30-105`, including comments)
- Modify: `packages/run/src/acpRun.ts` — delete the moved block, re-import + re-export from base so every existing import site (`chatRoutes.ts`, `chatSession.ts`, tests) keeps working:

```typescript
import { connectAcpAdapter, createLogger, createAccumulator, applyUpdate, normalizeAcpError, type AgentDescriptor, type AcpErrorKind, type ToolInvocation, type RunResult, type RunAccumulator } from "@agentgem/base";
export { createAccumulator, applyUpdate } from "@agentgem/base";
export type { AgentDescriptor, ToolInvocation, RunResult, RunAccumulator } from "@agentgem/base";
```

- Modify: `packages/base/src/index.ts` — re-export `./acpUpdates.js`.

- [ ] **Step 1**: Move the code exactly as-is (no edits beyond the file header comment).
- [ ] **Step 2**: Clean stale build outputs, then verify: `find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete && rm -rf dist packages/*/dist && pnpm build && pnpm test`. Expected: green — behavior-preserving move. (Full dist clean is mandatory here: vitest runs compiled dist and a stale `acpRun.js` would shadow the move.)
- [ ] **Step 3**: Commit — `git commit -m "base(acp): move update reducer (applyUpdate/createAccumulator) from run to base"`

### Task 4.2: Shared `promptRun` + turn generator

**Files:**
- Create: `packages/base/src/acpTurn.ts`
- Test: `src/__tests__/acpTurn.test.ts`

**Interfaces:**
- Consumes: `RawAcpSession` (acpSession), `createAccumulator`/`applyUpdate`/`RunResult`/`ToolInvocation` (acpUpdates).
- Produces:
  - `promptRun(session: Pick<RawAcpSession, "prompt">, text: string, handlers?: { onDelta?: (c: string) => void; onToolCall?: (t: ToolInvocation) => void }): Promise<RunResult>` — the one true prompt-and-fold.
  - `type TurnEvent = { type: "delta"; text: string } | { type: "tool"; tool: ToolInvocation } | { type: "done"; result: RunResult } | { type: "failed"; error: string }`
  - `turnEvents(start: (onDelta: (c: string) => void, onToolCall: (t: ToolInvocation) => void) => Promise<RunResult>): AsyncGenerator<TurnEvent>` — the queue/wake push-to-pull bridge currently inlined in `ChatManager.sendMessage`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/acpTurn.test.ts
import { describe, it, expect } from "vitest";
import { promptRun, turnEvents, type TurnEvent } from "@agentgem/base";

const fakeSession = {
  async prompt(_text: string, onUpdate: (u: unknown) => void) {
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi " } });
    onUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read", status: "pending" });
    onUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    onUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
    return "end_turn";
  },
};

describe("promptRun", () => {
  it("folds updates into a RunResult with merged tool statuses", async () => {
    const deltas: string[] = [];
    const result = await promptRun(fakeSession, "q", { onDelta: (c) => deltas.push(c) });
    expect(result.text).toBe("hi there");
    expect(result.stopReason).toBe("end_turn");
    expect(result.toolCalls).toEqual([{ toolCallId: "t1", title: "Read", kind: undefined, status: "completed" }]);
    expect(deltas).toEqual(["hi ", "there"]);
  });
});

describe("turnEvents", () => {
  it("yields deltas and tools live, then done", async () => {
    const seen: TurnEvent[] = [];
    for await (const ev of turnEvents((onDelta, onToolCall) => promptRun(fakeSession, "q", { onDelta, onToolCall }))) seen.push(ev);
    expect(seen.map((e) => e.type)).toEqual(["delta", "tool", "delta", "done"]);
  });
  it("yields failed when the turn rejects", async () => {
    const seen: TurnEvent[] = [];
    for await (const ev of turnEvents(async () => { throw new Error("boom"); })) seen.push(ev);
    expect(seen).toEqual([{ type: "failed", error: "boom" }]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — missing exports; expected.

- [ ] **Step 3: Implement**

```typescript
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// packages/base/src/acpTurn.ts
//
// The unified ACP turn façade — the consolidation the acpRun header promised
// ("the two connectFns should be unified"). promptRun is the ONE prompt-and-fold
// every caller (gem runner, chat, recommender) routes through; turnEvents is the
// push→pull bridge (queue + wake) extracted from ChatManager.sendMessage so live
// streaming isn't re-invented per surface. Shape inspired by acpx's AcpRuntimeTurn
// (events stream + terminal result), collapsed to what our callers actually use.
import type { RawAcpSession } from "./acpSession.js";
import { createAccumulator, applyUpdate, type RunResult, type ToolInvocation } from "./acpUpdates.js";

export interface PromptHandlers {
  onDelta?: (chunk: string) => void;
  onToolCall?: (tool: ToolInvocation) => void;
}

/** Send one turn on a raw session and fold its updates into a RunResult. */
export async function promptRun(
  session: Pick<RawAcpSession, "prompt">,
  text: string,
  handlers?: PromptHandlers,
): Promise<RunResult> {
  const acc = createAccumulator();
  const stopReason = await session.prompt(text, (u) =>
    applyUpdate(acc, (u ?? {}) as Parameters<typeof applyUpdate>[1], handlers),
  );
  return { ...acc, stopReason };
}

export type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; tool: ToolInvocation }
  | { type: "done"; result: RunResult }
  | { type: "failed"; error: string };

/**
 * Bridge a push-callback turn into a pull async generator, yielding events AS they
 * arrive (not buffered until the end — a long turn must be distinguishable from a
 * hang). `start` receives the two push handlers and returns the turn's result.
 */
export async function* turnEvents(
  start: (onDelta: (c: string) => void, onToolCall: (t: ToolInvocation) => void) => Promise<RunResult>,
): AsyncGenerator<TurnEvent> {
  const queue: TurnEvent[] = [];
  let wake: (() => void) | null = null;
  const bump = () => { if (wake) { wake(); wake = null; } };
  let settled = false;
  let result: RunResult | undefined;
  let error: Error | undefined;

  const running = start(
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
  await running;

  if (error) { yield { type: "failed", error: error.message }; return; }
  yield { type: "done", result: result! };
}
```

Re-export `./acpTurn.js` from the base barrel.

- [ ] **Step 4: Run tests** — PASS expected.
- [ ] **Step 5: Commit** — `git commit -m "base(acp): promptRun + turnEvents — the unified turn façade"`

### Task 4.3: Point all three façades at promptRun; ChatManager at turnEvents

**Files:**
- Modify: `packages/run/src/acpRun.ts` — `connectRunSession`'s `prompt` (:222-225) becomes `prompt: (text, onDelta, onToolCall) => promptRun(session, text, { onDelta, onToolCall })`.
- Modify: `packages/app/src/goldmine/chatRoutes.ts` — both `open` and `openExisting` in `makeChatConnectFn` replace their accumulator blocks the same way (drop the now-unused `createAccumulator`/`applyUpdate` imports).
- Modify: `packages/insight/src/acpRecommender.ts` — `defaultConnectFn`'s `promptText` (:306-316) becomes:

```typescript
        async promptText(text: string, onDelta?: (chunk: string) => void) {
          const result = await promptRun(session, text, { onDelta });
          return result.text;
        },
```

(add `promptRun` to the `@agentgem/base` import; note this also fixes a latent quirk — the old copy aggregated only `agent_message_chunk` and that behavior is preserved since `promptText` returns `.text` only.)
- Modify: `packages/run/src/chatSession.ts` — `sendMessage`'s inline queue/wake block (:144-173) collapses to:

```typescript
      yield { type: "phase", phase: "running" };
      for await (const ev of turnEvents((onDelta, onToolCall) => chat.handle.prompt(prompt, onDelta, onToolCall))) {
        if (ev.type === "done") chat.lastMs = this.now();
        yield ev;
      }
```

(`ChatEvent`'s `delta`/`tool`/`done`/`failed` arms are structurally identical to `TurnEvent` — verify with the compiler, do not cast. Keep the `finally { chat.running = false; }` frame and the early-return guards untouched. Add `turnEvents` to the `@agentgem/base` import.)

- [ ] **Step 1**: Make the four edits.
- [ ] **Step 2**: Full clean + test: `find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete && rm -rf dist packages/*/dist && pnpm build && pnpm test`. The existing suites (chatStudio, gemRunStream, acpResume, insight recommender tests via `cd packages/insight && pnpm test`) are the behavioral safety net — all must stay green with zero test edits. Any test that needs editing means behavior changed: stop and investigate.
- [ ] **Step 3**: Delete the now-stale consolidation NOTE at `acpRun.ts:19-21` (the promise it makes is fulfilled by this PR).
- [ ] **Step 4**: Commit — `git commit -m "acp: route runner, chat, and recommender façades through shared promptRun/turnEvents"` — push, PR titled "ACP turn-API unification: one prompt-fold, one stream bridge", standard merge ritual, remove worktree.

---

## Self-Review

1. **Spec coverage**: hardening trio → Tasks 1.2–1.4; real resume with guarded ladder → Tasks 2.1–2.3; timeout salvage + error normalization → Tasks 3.1–3.2; turn API unification → Tasks 4.1–4.3. The acpx "desired-state replay" idea is deliberately NOT planned — we have no per-session desired mode/model store to replay (modes are set per-open); noted as future work.
2. **Placeholder scan**: PR bodies for 2–4 are abbreviated ("...") — acceptable since PR 1 shows the full template; all code steps carry complete code. Task 2.3 Step 5's live smoke depends on the real adapter's advertised capabilities, which cannot be pre-written — the step states both acceptable outcomes.
3. **Type consistency**: `ChatCtx.openExisting` (2.2) matches `makeChatConnectFn.openExisting` (2.3); `stateOf().resumed` (2.2) is read by the route (2.3); `AcpAgentInfo`/helpers (1.4) are consumed in 2.1; `promptRun`/`turnEvents` signatures (4.2) match all call sites in 4.3; `GemRunOutcome.errorKind` uses `AcpErrorKind` imported from base (3.1→3.2).

## Risks called out to the human

- **Task 2 hinges on adapter support**: `claude-agent-acp@0.51.0` / `codex-acp@1.1.0` may not advertise `loadSession`/`session.resume`. The design is safe either way (capability-gated, fallback = today's behavior), but the headline UX win only materializes where the capability exists. The live smoke in Task 2.3 answers this empirically; if neither adapter supports it, consider bumping `ADAPTER_VERSIONS` in a follow-up.
- **PR 4 touches four packages at once** — it is behavior-preserving by construction (existing tests unchanged), but it's the PR most exposed to the stale-dist trap; both clean-build steps are mandatory.
- **`app.onNotification` handler param shape** (Task 2.1) is written defensively (`params?.sessionId`) but verified only against SDK typings, not a live adapter — the fake-adapter integration test covers the wire shape end-to-end.
