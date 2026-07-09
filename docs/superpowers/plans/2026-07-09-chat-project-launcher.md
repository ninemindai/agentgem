# Chat Project Launcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Chat session start in a chosen project's working directory (picked from server-known projects, normal permissions), instead of always the neutral cwd.

**Architecture:** `POST /api/chat` gains an optional `project` (root path). The server validates it against an allow-list (discovered ∪ recent projects) via `resolveProjectCwd` and uses the canonical path as the agent cwd with the neutral brief. Two cwd gates are updated in lockstep: `studioChatArgs` (chooses the cwd) and the `ChatManager.connectFn` wrapper (defense-in-depth re-guard) — both honor a project cwd only if it's allow-listed. A raw request path is never trusted.

**Tech Stack:** TypeScript (ESM), Express (duck-typed), React (console SPA), Vitest. Files in root `src/` and `packages/console`.

## Global Constraints

- Node floor `>=24`. TS ESM — import paths end in `.js`.
- **Security invariant:** a raw request path must NEVER become the agent cwd. cwd is honored only when it passes `studioCwd` (miniapp/neutral) or is in the project allow-list. Preserve the comment at `src/goldmine/chatRoutes.ts:131-133`.
- `POST /api/chat` is a raw `fetch` on the client and reads `req.body` directly on the server — there is **no zod route/body schema** for it (nothing to mirror).
- `miniapp` and `project` are mutually exclusive.
- Project chats use the **neutral** brief and **normal** permission (`permission: undefined`) — NOT the studio `"allow"`. Project chats are NOT added to the `chatId → miniapp` checkpoint map.
- Test commands:
  - **root/server** (`src/`): `pnpm build` then `npx vitest run dist/goldmine/__tests__/chatRoutes.test.js` (root vitest globs `dist/**/__tests__/**/*.test.js`).
  - **console**: `pnpm -C packages/console exec vitest run <src-path>` (jsdom); typecheck `pnpm -C packages/console run typecheck`.
- Commit after every task.

## File map

| File | Change |
|------|--------|
| `src/goldmine/chatRoutes.ts` | `studioChatArgs` project branch; `ChatRouteDeps.resolveProjectCwd?`; route passthrough + error classifier + no-checkpoint; export `resolveChatCwd` helper |
| `src/goldmine/__tests__/chatRoutes.test.ts` | `buildTestApp` gains `resolveProjectCwd`; tests for studioChatArgs, the route, and `resolveChatCwd` |
| `src/index.ts` | imports; build allow-list + `resolveProjectCwd`; inject into `registerChatRoutes`; `connectFn` uses `resolveChatCwd` |
| `packages/console/src/panels/_shared/ScopePicker.tsx` | optional `globalLabel?` + `disabled?` props |
| `packages/console/src/panels/Chat/index.tsx` | launcher (`ScopePicker`) + `project` in the POST body |
| `packages/console/src/panels/Chat/Chat.launcher.test.tsx` | launcher renders + sends `project` |
| `packages/console/src/panels/_shared/ScopePicker.test.tsx` | new props covered |

---

## Task 1: Server — `chatRoutes.ts` project support

**Files:**
- Modify: `src/goldmine/chatRoutes.ts`
- Test: `src/goldmine/__tests__/chatRoutes.test.ts`

**Interfaces:**
- Produces:
  - `ChatRouteDeps.resolveProjectCwd?: (root: string) => string | null` (validated canonical cwd, or null if not allow-listed).
  - `studioChatArgs(body: { agentId?, miniapp?, project? }, deps)` — honors `project` via `resolveProjectCwd`.
  - `export function resolveChatCwd(requested: string, chatCwd: string, resolveProjectCwd?: (root: string) => string | null): string` — the connectFn re-guard (Task 2 consumes it).

- [ ] **Step 1: Write the failing tests**

Append to `src/goldmine/__tests__/chatRoutes.test.ts`. First, extend `buildTestApp` (around line 40-60) to inject `resolveProjectCwd` and capture the cwd passed to `openChat` — read the existing harness and add, to the `registerChatRoutes({...})` deps object:
```ts
    resolveProjectCwd: (root: string) => (root === "/repo/ok" ? "/repo/ok" : null),
```
If the harness uses a fake `ChatManager`/`openChat` that doesn't record args, extend it to record the last `openChat` args into an `opts.openArgs` array (mirror how `opts.checkpoints` is threaded). Then add:

```ts
import { studioChatArgs, resolveChatCwd } from "../chatRoutes.js";

describe("studioChatArgs project launch", () => {
  const base = { buildBrief: async () => "NEUTRAL", goldmineMcp: () => [], resolveStudio: () => ({ cwd: "/tmp/m", brief: "S" }) };
  const withProj = { ...base, resolveProjectCwd: (r: string) => (r === "/repo/ok" ? "/repo/ok" : null) };

  it("honors an allow-listed project as cwd with the neutral brief and no force-allow", async () => {
    const a = await studioChatArgs({ agentId: "x", project: "/repo/ok" }, withProj);
    expect(a.cwd).toBe("/repo/ok");
    expect(a.brief).toBe("NEUTRAL");
    expect(a.permission).toBeUndefined();
  });
  it("rejects a non-allow-listed project", async () => {
    await expect(studioChatArgs({ agentId: "x", project: "/repo/nope" }, withProj)).rejects.toThrow(/unknown project/);
  });
  it("rejects project + miniapp together", async () => {
    await expect(studioChatArgs({ agentId: "x", project: "/repo/ok", miniapp: "m" }, withProj)).rejects.toThrow(/mutually exclusive/);
  });
  it("throws when resolveProjectCwd is not provided", async () => {
    await expect(studioChatArgs({ agentId: "x", project: "/repo/ok" }, base as never)).rejects.toThrow(/project launch not available/);
  });
  it("no project → neutral args unchanged", async () => {
    const a = await studioChatArgs({ agentId: "x" }, withProj);
    expect(a.cwd).toBeUndefined();
    expect(a.brief).toBe("NEUTRAL");
  });
});

describe("resolveChatCwd", () => {
  const chatCwd = "/home/.agentgem/chat";
  const rp = (r: string) => (r === "/repo/ok" ? "/repo/ok" : null);
  it("honors an allow-listed project path", () => {
    expect(resolveChatCwd("/repo/ok", chatCwd, rp)).toBe("/repo/ok");
  });
  it("falls back to neutral for an unlisted path", () => {
    expect(resolveChatCwd("/repo/evil", chatCwd, rp)).toBe(chatCwd);
  });
  it("passes the neutral cwd through", () => {
    expect(resolveChatCwd(chatCwd, chatCwd, rp)).toBe(chatCwd);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/chatRoutes.test.js`
Expected: FAIL — `studioChatArgs` ignores `project`; `resolveChatCwd` not exported.

- [ ] **Step 3: Implement in `chatRoutes.ts`**

Add `resolveProjectCwd` to `ChatRouteDeps` (after `resolveStudio`):
```ts
  // Project launch: resolve a project ROOT (raw path from the body) to a VALIDATED canonical
  // cwd, or null if it isn't in the server's discovered/recent allow-list. Absent → unavailable.
  resolveProjectCwd?: (root: string) => string | null;
```

Rewrite `studioChatArgs` — body type + project branch + mutual exclusion:
```ts
export async function studioChatArgs(
  body: { agentId?: unknown; miniapp?: unknown; project?: unknown },
  deps: Pick<ChatRouteDeps, "buildBrief" | "goldmineMcp" | "resolveStudio" | "resolveProjectCwd">,
): Promise<{ agentId: string; brief: string; mcpServers: McpServerStdio[]; cwd?: string; permission?: "allow" | "deny" }> {
  const agentId = String(body?.agentId ?? "");
  if (!agentId) throw new Error("agentId required");
  const miniapp = body?.miniapp ? String(body.miniapp) : "";
  const project = body?.project ? String(body.project) : "";
  if (miniapp && project) throw new Error("miniapp and project are mutually exclusive");
  if (miniapp) {
    if (!deps.resolveStudio) throw new Error("studio not available");
    const s = deps.resolveStudio(miniapp);
    return { agentId, brief: s.brief, mcpServers: deps.goldmineMcp(), cwd: s.cwd, permission: "allow" };
  }
  if (project) {
    if (!deps.resolveProjectCwd) throw new Error("project launch not available");
    const cwd = deps.resolveProjectCwd(project);   // validates against the allow-list
    if (!cwd) throw new Error("unknown project");
    // Neutral brief + normal permission: a project chat is not a studio session and must not
    // silently gain write access to the real repo.
    return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp(), cwd };
  }
  return { agentId, brief: await deps.buildBrief(), mcpServers: deps.goldmineMcp() };
}
```

Add the `resolveChatCwd` helper (near the top, after imports — it needs `studioCwd` from `@agentgem/play`, which is already imported by `index.ts`; import it here too: `import { studioCwd } from "@agentgem/play";`). Also `import { resolve } from "node:path";` if not present:
```ts
// The connectFn re-guard (defense-in-depth): honor `requested` if studioCwd accepts it
// (miniapp path or the neutral cwd) OR if it's an allow-listed project; else neutral cwd.
export function resolveChatCwd(requested: string, chatCwd: string, resolveProjectCwd?: (root: string) => string | null): string {
  const viaStudio = studioCwd(requested, chatCwd);
  if (resolve(viaStudio) !== resolve(chatCwd)) return viaStudio;   // a valid miniapp path
  return resolveProjectCwd?.(requested) ?? viaStudio;              // validated project, else neutral
}
```

In the `POST /api/chat` handler: don't checkpoint project chats (unchanged — only `miniapp` is added to `chatMiniapps`, so this already holds), and extend the client-error classifier:
```ts
      const clientErr = msg === "agentId required" || msg === "studio not available"
        || msg.startsWith("invalid miniapp name")
        || msg === "unknown project" || msg === "project launch not available"
        || msg === "miniapp and project are mutually exclusive";
```
(The handler already passes `req.body` to `studioChatArgs`, so `project` flows through with no other change.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm build && npx vitest run dist/goldmine/__tests__/chatRoutes.test.js`
Expected: PASS (new + existing chat-route tests).

- [ ] **Step 5: Commit**

```bash
git add src/goldmine/chatRoutes.ts src/goldmine/__tests__/chatRoutes.test.ts
git commit -m "feat(chat): studioChatArgs honors a server-validated project cwd + resolveChatCwd guard"
```

---

## Task 2: Server — `index.ts` wiring (allow-list + connectFn guard)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: Task 1's `resolveChatCwd` and `ChatRouteDeps.resolveProjectCwd`.
- Produces: no new exports — glue. Gated by build + typecheck.

- [ ] **Step 1: Add imports**

At the top of `src/index.ts`, add (grouping with existing imports from those packages):
```ts
import { discoverProjects } from "@agentgem/testbed";
import { readRecents } from "@agentgem/capture";
import { resolveProject, resolveDirs } from "@agentgem/model";
```
And extend the existing `chatRoutes.js` import to include `resolveChatCwd`:
```ts
import { registerChatRoutes, makeChatConnectFn, installAgentFn, goldmineMcpServers, resolveChatCwd } from "./goldmine/chatRoutes.js";
```
(`agentgemHome` is already imported. If `resolveProject`/`resolveDirs` are already imported from `@agentgem/model` elsewhere in the file, add only the missing names to that existing import instead of duplicating.)

- [ ] **Step 2: Build the allow-list + resolveProjectCwd, wire the connectFn**

In the chat block (`src/index.ts:315-341`), inside the `{ ... }` scope, after `const chatCwd = ...`:
```ts
    // Allow-list of honorable project roots = discovered ∪ recent, canonicalized. Recomputed
    // per open()/launch (a disk scan, but each runs once per session start).
    const resolveProjectCwd = (root: string): string | null => {
      const allow = new Set(
        [...discoverProjects(resolveDirs(undefined)).map((p) => p.path),
         ...readRecents(agentgemHome()).map((r) => r.path)].map(resolveProject),
      );
      const canon = resolveProject(root);
      return allow.has(canon) ? canon : null;
    };
```

Change the `connectFn` open wrapper (line 329-330) from:
```ts
            open: (cwd: string, opts?: { mcpServers?: unknown[] }) =>
              conn.ctx.open(studioCwd(cwd, chatCwd), opts),
```
to:
```ts
            open: (cwd: string, opts?: { mcpServers?: unknown[] }) =>
              conn.ctx.open(resolveChatCwd(cwd, chatCwd, resolveProjectCwd), opts),
```

Add the dep to the `registerChatRoutes({...})` call (after `resolveStudio`):
```ts
      resolveProjectCwd,
```
(`studioCwd` may now be unused in `index.ts` — if the linter/tsc flags it, remove it from the `@agentgem/play` import.)

- [ ] **Step 3: Build + typecheck**

Run: `pnpm build` — expect `tsc -b` clean + console SPA written.
Expected: PASS. No new unit test — `resolveProjectCwd`'s membership logic is exercised end-to-end by the final drive; the pure `resolveChatCwd`/`studioChatArgs` are covered in Task 1.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(chat): wire resolveProjectCwd allow-list + project-aware connectFn cwd guard"
```

---

## Task 3: Client — launcher UI

**Files:**
- Modify: `packages/console/src/panels/_shared/ScopePicker.tsx`, `packages/console/src/panels/Chat/index.tsx`
- Test: `packages/console/src/panels/_shared/ScopePicker.test.tsx` (append), `packages/console/src/panels/Chat/Chat.launcher.test.tsx` (create)

**Interfaces:**
- Consumes: `ScopePicker`/`Scope` from `../_shared/ScopePicker.js`.
- Produces: `ScopePicker` gains optional `globalLabel?: string` (default `"Global"`) and `disabled?: boolean` (default `false`).

- [ ] **Step 1: Write the failing ScopePicker prop test**

Append to `packages/console/src/panels/_shared/ScopePicker.test.tsx`:
```tsx
it("uses a custom globalLabel and disables its buttons", () => {
  render(<ScopePicker apiBase="" scope={{ kind: "global" }} onScope={() => {}} globalLabel="Neutral" disabled />);
  expect(screen.getByRole("button", { name: "Neutral" })).toBeDisabled();
  expect(screen.getByRole("button", { name: /project/i })).toBeDisabled();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/_shared/ScopePicker.test.tsx`
Expected: FAIL — no `globalLabel`/`disabled` handling; button reads "Global".

- [ ] **Step 3: Implement ScopePicker props**

Update the signature + the two buttons:
```tsx
export function ScopePicker({ apiBase, scope, onScope, globalLabel = "Global", disabled = false }: {
  apiBase: string; scope: Scope; onScope: (s: Scope) => void; globalLabel?: string; disabled?: boolean;
}) {
```
On the first button: `disabled={disabled}` and label `{globalLabel}`:
```tsx
      <button className={"obs-range-btn" + (scope.kind === "global" ? " is-active" : "")} disabled={disabled} onClick={() => onScope({ kind: "global" })}>{globalLabel}</button>
      <button className={"obs-range-btn" + (scope.kind === "project" ? " is-active" : "")} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {scope.kind === "project" ? `Project: ${scope.label}` : "Project"} ▾
      </button>
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/_shared/ScopePicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the failing Chat launcher test**

Create `packages/console/src/panels/Chat/Chat.launcher.test.tsx`:
```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { Chat } from "./index.js";

afterEach(cleanup);

// Records the POST /api/chat body so we can assert `project` is sent.
function stubFetch(bodies: string[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/agents")) return { ok: true, json: async () => ({ agents: [{ id: "claude-code", name: "Claude Code", available: true }] }) } as Response;
    if (u.endsWith("/api/testbed/recents")) return { ok: true, json: async () => ({ recents: [{ path: "/repo/a", flavor: "x", name: "a", lastUsed: null, exists: true }] }) } as Response;
    if (u.endsWith("/api/testbed/projects")) return { ok: true, json: async () => ({ projects: [] }) } as Response;
    if (u.endsWith("/api/chat")) { bodies.push(String(init?.body ?? "")); return { ok: true, json: async () => ({ chatId: "c1" }) } as Response; }
    return { ok: true, json: async () => ({}) } as Response;
  }));
}

describe("Chat project launcher", () => {
  it("sends the picked project root in the POST /api/chat body", async () => {
    const bodies: string[] = [];
    stubFetch(bodies);
    render(<Chat apiBase="" />);
    await screen.findByRole("button", { name: /neutral/i });
    fireEvent.click(screen.getByRole("button", { name: /project/i }));
    fireEvent.click(await screen.findByText("/repo/a"));
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect(JSON.parse(bodies[0])).toMatchObject({ agentId: "claude-code", project: "/repo/a" });
  });
});
```
> If `Chat`'s send trigger isn't Enter-on-textbox (read `Chat/index.tsx`), drive whatever the panel uses (a Send button). The assertion — `project` present in the body — is what matters. If the panel's export name differs, import it as the panel registers it.

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm -C packages/console exec vitest run src/panels/Chat/Chat.launcher.test.tsx`
Expected: FAIL — no launcher; body has no `project`.

- [ ] **Step 7: Implement the launcher in `Chat/index.tsx`**

Add the import + state:
```tsx
import { ScopePicker, type Scope } from "../_shared/ScopePicker.js";
// ...inside the component, with the other useState calls:
const [launch, setLaunch] = useState<Scope>({ kind: "global" });
```
Render the launcher next to the agent picker (in the header block around line 177-185, after the agent `<select>`):
```tsx
      <span style={{ marginLeft: 12, marginRight: 8, fontWeight: 600 }}>Start in</span>
      <ScopePicker apiBase={apiBase} scope={launch} onScope={setLaunch} globalLabel="Neutral" disabled={chatId !== null} />
```
Add `project` to the POST body (the raw fetch around line 71-75):
```tsx
          body: JSON.stringify({ agentId, ...(launch.kind === "project" ? { project: launch.root } : {}) }),
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm -C packages/console exec vitest run src/panels/Chat/Chat.launcher.test.tsx src/panels/_shared/ScopePicker.test.tsx`
Expected: PASS.

- [ ] **Step 9: Typecheck + Optimize/Setup unaffected**

Run: `pnpm -C packages/console run typecheck` (clean) and `pnpm -C packages/console exec vitest run src/panels/Optimize src/panels/Setup` (still green — the new ScopePicker props are optional/defaulted).

- [ ] **Step 10: Commit**

```bash
git add packages/console/src/panels/_shared/ScopePicker.tsx packages/console/src/panels/Chat/index.tsx packages/console/src/panels/Chat/Chat.launcher.test.tsx packages/console/src/panels/_shared/ScopePicker.test.tsx
git commit -m "feat(console): Chat 'Start in' project launcher (reuses ScopePicker)"
```

---

## Final verification

- [ ] **Full build + suite:** `pnpm test` (root, `tsc -b && vitest run`) — expect green.
- [ ] **Console suite (local, not in CI):** `pnpm -C packages/console exec vitest run && pnpm -C packages/console run typecheck`.
- [ ] **Drive it (superpowers:verification):** `PORT=<free> node dist/index.js`; open `#/chat`; confirm "Start in: Neutral | Project ▾" renders; pick a discovered project; send a message; verify (via the server log / a filesystem probe) the agent's cwd is the project, not the neutral `~/.agentgem/chat`. Also confirm a `POST /api/chat` with an unlisted `project` returns 400 (curl).
- [ ] **Integrate:** push, open PR, CI-gate (`test (24)`+`test (26)`), merge once green, verify each commit landed on `origin/main`.

## Self-review notes

- **Spec coverage:** selection+validation (Task 1 `resolveProjectCwd` + Task 2 allow-list), mutual exclusion / neutral brief / normal permission (Task 1), the connectFn second gate (Task 1 `resolveChatCwd` + Task 2 wiring), raw-fetch client + launcher (Task 3), tests each task. ✓
- **Security invariant** preserved: both cwd gates honor a project only via allow-list membership; a raw path falls back to neutral. ✓
- **No schema mirror** for `/api/chat` (raw fetch + `req.body`) — no client/server zod drift risk. ✓
- **Type consistency:** `resolveProjectCwd: (root: string) => string | null` and `resolveChatCwd(requested, chatCwd, resolveProjectCwd)` identical across Tasks 1/2. ✓
