# Chat project launcher

**Date:** 2026-07-09
**Status:** Approved design, ready for planning
**Branch:** `feat/chat-project-launcher`

## Problem

The Chat tab always spins up a **neutral** conversation: `POST /api/chat` accepts only
`{ agentId }` (and a studio `miniapp` name), and without a `miniapp` the agent runs in a
neutral cwd with the neutral brief. There is no way to start a chat **in a project's
working directory**, so an ephemeral chat can't act as a project-scoped coding session.

The blocker is deliberate security: `src/goldmine/chatRoutes.ts` never lets a raw request
path become the agent's cwd. A `miniapp` is sent as a **name** that the server resolves to
a **validated** cwd (jailed to the miniapp registry). Any project launcher must follow the
same "send an identifier, server validates against a known list" rule — not send a raw path.

## Goal

Let a user start a Chat session in a chosen project's working directory, picking only from
**server-known** projects (discovered ∪ recent), running with **normal** (consent-prompting)
tool permissions.

Non-goals: no free-path/arbitrary-directory entry; no auto-grant of write permission; no
project-tailored brief (the neutral goldmine brief is used); no change to `@agentgem/run`
(`ChatManager`).

## The selection + security model (crux)

- **Allow-list = discovered ∪ recent projects.** The server's set of honorable project roots
  is `discoverProjects(resolveDirs(undefined))` (`@agentgem/testbed`, `ProjectCandidate.path`)
  ∪ `readRecents(agentgemHome())` (`@agentgem/capture`, `RecentEntry.path`) — the exact
  same source the console's `/api/testbed/projects` + `/api/testbed/recents` routes (and the
  ScopePicker) already use.
- **Validation.** A request's `project` is honored as cwd **only if** `resolveProject(project)`
  (canonicalize, `@agentgem/model`) is a member of the canonicalized allow-list. In the list →
  use that canonical path as cwd. Not in the list → **400 error, never a silent fallback**.
- A raw request path is never trusted as cwd; the existing invariant holds unchanged.
- **Tradeoff (accepted):** a project with no session history / not recently used won't be in
  the allow-list, so it won't appear in the dropdown or be launchable. A later iteration could
  widen the list (e.g. discovered git repos).

## Server wiring (`src/goldmine/chatRoutes.ts`, `src/index.ts`)

### `studioChatArgs`
- Extend the body type from `{ agentId?, miniapp? }` to `{ agentId?, miniapp?, project? }`.
- `miniapp` and `project` are **mutually exclusive** — both present → throw (client error → 400).
- New injected dep on `ChatRouteDeps`:
  ```ts
  // Resolve a project ROOT (raw path from the body) to a VALIDATED canonical cwd, or null if
  // it isn't in the server's discovered/recent allow-list. Absent → project launch unavailable.
  resolveProjectCwd?: (root: string) => string | null;
  ```
- Project branch (when `project` is set and no `miniapp`):
  - `if (!deps.resolveProjectCwd) throw new Error("project launch not available")`.
  - `const cwd = deps.resolveProjectCwd(project); if (!cwd) throw new Error("unknown project")`.
  - Return `{ agentId, brief: await deps.buildBrief() (neutral), mcpServers: deps.goldmineMcp(), cwd, permission: undefined }` — **normal permission, NOT the studio `"allow"`**.
- No `project` and no `miniapp` → neutral path, unchanged.

### `registerChatRoutes` / `POST /api/chat`
- Read `project` from the request body alongside `agentId`/`miniapp` and pass it to
  `studioChatArgs` (via the existing `req.body` pass-through — `studioChatArgs` already takes
  the raw body subset).
- Extend the client-error classifier so `"unknown project"`, `"project launch not available"`,
  and the mutual-exclusion error map to **400** (like the existing `invalid miniapp name`).
- `project` chats are NOT studio sessions: do **not** add them to the `chatId → miniapp`
  checkpoint map.

### `src/index.ts` (dependency injection)
- Inject `resolveProjectCwd` parallel to `resolveStudio`:
  ```ts
  resolveProjectCwd: (root) => {
    const allow = new Set(
      [...discoverProjects(resolveDirs(undefined)).map((p) => p.path),
       ...readRecents(agentgemHome()).map((r) => r.path)].map(resolveProject),
    );
    const canon = resolveProject(root);
    return allow.has(canon) ? canon : null;
  },
  ```
  `discoverProjects` (`@agentgem/testbed`), `readRecents` (`@agentgem/capture`),
  `resolveProject` + `resolveDirs` (`@agentgem/model`), and `agentgemHome` (`@agentgem/model`)
  are used this way in `gem.controller.ts` today; the plan adds the needed imports to
  `src/index.ts` (where the injection lives). Consider extracting the allow-list builder into a
  small named helper so the route wiring stays readable.

## Client (`packages/console/src/panels/Chat/index.tsx`)

- A **"Start in: `Neutral | Project ▾`"** launcher next to the agent picker. Default **Neutral**.
  Reuses the discovered-projects list logic from `_shared/ScopePicker` — either by adding an
  optional `globalLabel` prop to `ScopePicker` (so `"Global"` becomes `"Neutral"`) or a thin
  dedicated picker; the lighter option is chosen in the plan.
- Disabled once the chat has started (same lifecycle as the existing agent `<select>`).
- On `POST /api/chat`, include `project: <root>` **only** when a project is selected; omit it
  for a neutral chat (backward-compatible).
- Client route `createChat` body schema (mirror in `packages/console/src/api/routes.ts`) gains
  an optional `project?: string` (server body schema gains it too — keep the mirrors in sync).

## Testing

- **`studioChatArgs` unit** (`src/goldmine/__tests__/chatRoutes.test.ts`):
  - allow-listed `project` → returns the validated cwd + neutral brief + `permission` undefined
    (not `"allow"`);
  - non-listed `project` → throws `"unknown project"`;
  - `project` + `miniapp` together → throws;
  - `resolveProjectCwd` absent → throws `"project launch not available"`;
  - neither → neutral args (unchanged).
- **Route** (same test file's Express harness): `POST /api/chat` with a valid `project` →
  `openChat` called with that cwd; an unlisted `project` → HTTP 400.
- **Client** (`packages/console/src/panels/Chat/*.test.tsx`): the launcher renders, sends
  `project` in the body only when a project is chosen, and disables after the chat starts.

## Feasibility notes (verified against current code)

- `studioChatArgs` already returns `{ agentId, brief, mcpServers, cwd?, permission? }` and the
  neutral/studio branch is unit-testable without Express (`src/goldmine/chatRoutes.ts:70`).
- `resolveStudio` is injected at `src/index.ts:339`; `resolveProjectCwd` mirrors that seam.
- Allow-list sources exist and are already used: `discoverProjects` (`packages/testbed`,
  called at `gem.controller.ts:1036`), `readRecents` (`packages/capture`, called at
  `gem.controller.ts:1028`), `resolveProject` (`packages/model/src/resolveDir.ts:13`).
- The security invariant ("no raw request path becomes cwd") is documented at
  `chatRoutes.ts:131-133` and is preserved: cwd only ever comes from an allow-list membership
  check.
