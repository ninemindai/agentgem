# Gem Review Staging — Console UI (Plan 2b of 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** The user-facing console UI for gem review staging: a Studio "Request review" button (with a group picker), a "Reviews" inbox panel (list → detail → comment/approve/request-changes/withdraw/install-to-test/resubmit), and a slow-polled unread badge. It calls the local `/api/review/*` routes shipped in Plan 2a.

**Architecture:** The console (`packages/console`, React) calls its local server via typed `defineRoute` clients in `api/routes.ts`. Plan 2a's `ReviewController` (`@api /api/review`) already signs+forwards to the aggregator, so Plan 2b is pure UI + thin route clients — no signing here.

**Tech Stack:** React, TypeScript (ESM `.js` specifiers), `@agentback/client` `defineRoute`/`makeClient`, Zod, Vitest + `@testing-library/react`.

**Scope:** Plan **2b of 2**, the final slice. Depends on Plan 2a's merged `/api/review/*` routes. Group *creation/management* is out of scope (MVP requires ≥1 existing group). Game/miniapp gems install-to-workspace like every other type; routing games to the miniapp **player** is a documented follow-on.

## Global Constraints

- ESM `.js` import specifiers. Match the existing console style (single quotes vs double — follow the file).
- Every route client is `defineRoute(METHOD, "/api/review/...", { body/query, response })` with a Zod shape matching Plan 2a's `ReviewController` schemas EXACTLY (read `src/review.controller.ts` in the repo root — the merged controller — for each route's real body/response). Call via `route.call(makeClient(apiBase), { body/query })`.
- The Studio "Request review" flow reuses the EXISTING identity gate (`useIdentity`/`useGitHubBind`/`ConnectGitHub`) and version resolution (`resolvePublishAction`/`publishStatusRoute`) already wired in `Studio.tsx` — do not reinvent them.
- ⚠️ **Console tests are NOT in CI** (documented repo gap: `test (24)` gates root `dist/__tests__`, not `packages/console`). Run locally: `pnpm -C packages/console exec vitest run`. The plan's final task states this explicitly.
- A staged review is targeted at a `groupId`; if the author is in 0 groups, the Request-review control is DISABLED with a hint (no group-creation UI in scope).
- Badge poll cadence is SLOW (`REVIEW_POLL_MS = 45_000`) — an async review flow doesn't need sub-minute latency, and `/review/inbox` is a signed aggregator round-trip.

## File Structure

- **Modify** `packages/console/src/api/routes.ts` — add the review route clients (grouped: Task 1 adds groups+request; Task 2 adds inbox/get/action routes; Task 3 adds install/resubmit).
- **Modify** `packages/console/src/panels/Play/Studio.tsx` — the "Request review" button + group picker + submit handler + status chip.
- **Create** `packages/console/src/panels/Reviews/index.tsx` — the inbox panel + `reviewsPage`.
- **Modify** `packages/console/src/pages.tsx` — register `reviewsPage`.
- **Modify** `packages/console/src/contract.ts` + `packages/console/src/shell/Shell.tsx` — optional `badge?` on `ConsolePage`, rendered in `item()`.
- **Create/Modify** tests: `panels/Play/__tests__/StudioReview.test.tsx`, `panels/Reviews/__tests__/Reviews.test.tsx`.

---

## Task 1: Studio "Request review" button + group picker

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `reviewGroupsRoute`, `reviewRequestRoute`)
- Modify: `packages/console/src/panels/Play/Studio.tsx`
- Test: `packages/console/src/panels/Play/__tests__/StudioReview.test.tsx`

**Interfaces (match Plan 2a's `ReviewController` — verify against `src/review.controller.ts`):**
```ts
export const reviewGroupsRoute = defineRoute("GET", "/api/review/groups", {
  response: z.object({ authenticated: z.boolean(), groups: z.array(z.object({ id: z.string(), name: z.string(), role: z.string() })) }),
});
export const reviewRequestRoute = defineRoute("POST", "/api/review/request", {
  body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), groupId: z.string(), description: z.string().optional() }),
  response: z.object({ ok: z.boolean(), requestId: z.string().optional(), rejected: z.string().optional() }),
});
```

**Behavior:**
- A "Request review" button in the `.play-studio-head` row (near the scope selector, `Studio.tsx:~349`). Clicking it: `save()` first (like `shareToExplore`), then gate on identity (`identity?.bound && identity.login`, else set a pending flag + show `ConnectGitHub`, resume via `useGitHubBind` `onBound`), then open a small group-picker (fetched via `reviewGroupsRoute` on first need).
- Group picker: a `<select>` of `groups` (from `reviewGroupsRoute`). If `authenticated` but `groups` is empty → the button/picker is disabled with the hint "Join or create a team to request review." If not authenticated → the identity gate handles it.
- On submit: resolve the version the same way publish does (call `publishStatusRoute` + `resolvePublishAction` → the `publish`/`confirm` version; for `confirm`, use `nextVersion`), then `reviewRequestRoute.call(makeClient(apiBase), { body: { workspace: name, scope: login, name, version, groupId, description } })`. On `{ok:true}` show a status chip "In review"; on `{ok:false}` show the `rejected` reason (e.g. `not-scope-owner`, `too-many-open`, `version-published`).

- [ ] **Step 1: Write the failing test**

Read `packages/console/src/panels/Play/__tests__/StudioShare.test.tsx` for the exact mount/mock pattern, then create `StudioReview.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { IdentityProvider } from "../../../identity/IdentityProvider.js";
import { Studio } from "../Studio.js";
import * as routes from "../../../api/routes.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  return render(
    <IdentityProvider apiBase="">
      <Studio apiBase="" name="snake" agents={[{ id: "claude", label: "Claude" }] as never} agentId="claude" onAgentIdChange={() => {}} onBack={() => {}} />
    </IdentityProvider>
  );
}

it("Request review: picks a group and submits a review request", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
  vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({ /* miniapp */ } as never);
  vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
  vi.spyOn(routes.reviewGroupsRoute, "call").mockResolvedValue({ authenticated: true, groups: [{ id: "g1", name: "Team", role: "admin" }] } as never);
  vi.spyOn(routes.publishStatusRoute, "call").mockResolvedValue({ exists: false, ownedByMe: false, latestVersion: null } as never);
  const req = vi.spyOn(routes.reviewRequestRoute, "call").mockResolvedValue({ ok: true, requestId: "req-1" } as never);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /request review/i }));
  // pick the group (the picker appears once groups load), then confirm
  const select = await screen.findByRole("combobox", { name: /group|team/i });
  fireEvent.change(select, { target: { value: "g1" } });
  fireEvent.click(await screen.findByRole("button", { name: /submit for review|request$/i }));
  await waitFor(() => expect(req).toHaveBeenCalledTimes(1));
  expect(req.mock.calls[0][1]).toMatchObject({ body: expect.objectContaining({ scope: "bob", groupId: "g1", version: "0.1.0" }) });
  expect(await screen.findByText(/in review/i)).toBeInTheDocument();
});

it("Request review: disabled with a hint when the author has no groups", async () => {
  vi.spyOn(routes.bindStatusRoute, "call").mockResolvedValue({ bound: true, login: "bob", sessionActive: true } as never);
  vi.spyOn(routes.playMiniappRoute, "call").mockResolvedValue({} as never);
  vi.spyOn(routes.playSaveRoute, "call").mockResolvedValue({ ok: true } as never);
  vi.spyOn(routes.reviewGroupsRoute, "call").mockResolvedValue({ authenticated: true, groups: [] } as never);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /request review/i }));
  expect(await screen.findByText(/join or create a team/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify it fails** — `pnpm -C packages/console exec vitest run src/panels/Play/__tests__/StudioReview.test.tsx` → FAIL (routes + button missing).

- [ ] **Step 3: Implement the routes + the Studio button/picker/handler**

Add the two routes to `api/routes.ts` (near `publishSetupRoute`). In `Studio.tsx`: add state (`reviewGroups`, `reviewGroupId`, `reviewStatus`, `reviewOpen`), a `requestReview()` handler mirroring `shareToExplore`'s identity gate + `checkAndPublish`'s version resolution, the group-picker UI (a `<select>` + a "Submit for review" button, shown when `reviewOpen`), and a status chip. Reuse the existing `ConnectGitHub` banner + `useGitHubBind` `onBound` resume (extend the existing `onBound` to also resume a pending review). Wire the button into the `.play-studio-head` row. Follow the existing handlers' structure exactly (read `shareToExplore`/`checkAndPublish`/`publishWorkspace` first).

> Implementer note: match the real `resolvePublishAction`/`publishStatusRoute` usage in the current `Studio.tsx` for version resolution; reuse `bumpPatch`. Keep the button labels stable (a test asserts `/request review/i`).

- [ ] **Step 4: Run to verify it passes** — PASS (2 cases).

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/api/routes.ts packages/console/src/panels/Play/Studio.tsx packages/console/src/panels/Play/__tests__/StudioReview.test.tsx
git commit -m "feat(review-ui): Studio Request-review button + group picker"
```

---

## Task 2: Reviews inbox panel (list → detail → approve/comment/changes/withdraw)

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `reviewInboxRoute`, `reviewGetRoute`, `reviewApproveRoute`, `reviewChangesRoute`, `reviewWithdrawRoute`, `reviewMessageRoute`, `reviewSeenRoute`)
- Create: `packages/console/src/panels/Reviews/index.tsx`
- Modify: `packages/console/src/pages.tsx`
- Test: `packages/console/src/panels/Reviews/__tests__/Reviews.test.tsx`

**Interfaces (match `ReviewController`):**
```ts
export const reviewInboxRoute = defineRoute("GET", "/api/review/inbox", { response: z.object({ requests: z.array(z.any()) }) });
export const reviewGetRoute = defineRoute("GET", "/api/review/get", { query: z.object({ requestId: z.string() }), response: z.object({ request: z.any().nullable() }) });
export const reviewApproveRoute = defineRoute("POST", "/api/review/approve", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean(), gemKey: z.string().optional(), version: z.string().optional(), rejected: z.string().optional() }) });
export const reviewChangesRoute = defineRoute("POST", "/api/review/changes", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean(), rejected: z.string().optional() }) });
export const reviewWithdrawRoute = defineRoute("POST", "/api/review/withdraw", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean(), rejected: z.string().optional() }) });
export const reviewMessageRoute = defineRoute("POST", "/api/review/message", { body: z.object({ requestId: z.string(), body: z.string() }), response: z.object({ ok: z.boolean(), rejected: z.string().optional() }) });
export const reviewSeenRoute = defineRoute("POST", "/api/review/seen", { body: z.object({ requestId: z.string() }), response: z.object({ ok: z.boolean() }) });
```
The inbox `requests` items carry (from `listInbox`): `{ id, groupName, gemKey, version, authorLogin, status, description, createdAtMs, messageCount, unread }`. The `get` `request` detail carries `{ id, gemKey, version, authorLogin, status, description, manifest, messages: [{ authorLogin, body, createdAtMs }] }`.

**Behavior:** `Reviews` fetches `reviewInboxRoute` on mount (Watch's `loadSessions` idiom), renders the list (unread dot, gemKey@version, author, status, groupName). Clicking a row opens the detail: fetch `reviewGetRoute` (which also marks-seen server-side), show metadata + the message thread + a comment box (`reviewMessageRoute`), and action buttons gated by role: **Approve** / **Request changes** for non-authors (`reviewApproveRoute`/`reviewChangesRoute`), **Withdraw** for the author (`reviewWithdrawRoute`). After an action, refresh the inbox. Register `reviewsPage = defineConsolePage({ id: "reviews", title: "Reviews", icon: "📝", order: <pick>, phase: "build", category: "projects", route: "#/reviews", component: ({ apiBase }) => <Reviews apiBase={apiBase} /> })` and add it to `pages.tsx`.

- [ ] **Step 1: Write the failing test** — `Reviews.test.tsx`: mount `<Reviews apiBase="" />` (with `IdentityProvider`), mock `reviewInboxRoute` → 1 open request, assert it renders; click it, mock `reviewGetRoute` → detail with a message, assert the detail + message render; mock `reviewApproveRoute`, click Approve, assert the route called with the requestId. (Read `panels/Watch/index.tsx` + an existing panel test for the mount/mock pattern.)

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** the routes + `panels/Reviews/index.tsx` + `pages.tsx` registration, following the Watch fetch-list idiom and the api-client call pattern.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit** — `feat(review-ui): Reviews inbox panel (list/detail/approve/comment/changes/withdraw)`.

---

## Task 3: Install-to-test + author resubmit

**Files:**
- Modify: `packages/console/src/api/routes.ts` (add `reviewInstallRoute`, `reviewResubmitRoute`)
- Modify: `packages/console/src/panels/Reviews/index.tsx`
- Test: `packages/console/src/panels/Reviews/__tests__/Reviews.test.tsx`

**Interfaces:**
```ts
export const reviewInstallRoute = defineRoute("POST", "/api/review/install", { body: z.object({ requestId: z.string(), name: z.string().optional(), consent: z.boolean().optional() }), response: z.object({ workspace: z.string(), executables: z.object({ mcp: z.array(z.string()), hooks: z.array(z.string()) }) }) });
export const reviewResubmitRoute = defineRoute("POST", "/api/review/resubmit", { body: z.object({ workspace: z.string(), scope: z.string(), name: z.string().optional(), version: z.string(), requestId: z.string(), description: z.string().optional() }), response: z.object({ ok: z.boolean(), rejected: z.string().optional() }) });
```

**Behavior:**
- In the request detail, an **"Install to test"** button → `reviewInstallRoute.call(..., { body: { requestId } })`. If it throws a 409 (`consent_required`, executable artifacts), show a confirm ("This gem runs executable artifacts — install anyway?") and retry with `consent: true`. On success show "Installed to workspace `<name>`" (all gem types install-to-workspace in this MVP; routing game gems to the miniapp player is a documented follow-on). Handle the 404 (`review_archive_gone`) with a friendly "archive no longer available".
- For an author viewing their own `changes-requested` request: a **"Resubmit"** action — re-runs the same build path as Studio's request (needs the workspace still present) via `reviewResubmitRoute`. (If the author's local workspace is gone, show a hint to reopen it in Studio; MVP can gate resubmit behind "workspace present".)

- [ ] Steps 1-5 (TDD): a test that Install-to-test calls `reviewInstallRoute` and shows the workspace name; a test that a 409 prompts consent then retries with `consent:true`. Commit — `feat(review-ui): install-to-test + resubmit in the Reviews inbox`.

---

## Task 4: Unread badge on the Reviews nav item

**Files:**
- Modify: `packages/console/src/contract.ts` (add optional `badge?: (apiBase: string) => ReactNode` — or a simpler count hook)
- Modify: `packages/console/src/shell/Shell.tsx` (render the badge in `item()`; a slow poller)
- Modify: `packages/console/src/panels/Reviews/index.tsx` (export a small `useReviewUnread(apiBase)` hook) OR a standalone poller
- Test: a small test that the badge shows the unread count.

**Behavior:** A poller (interval `REVIEW_POLL_MS = 45_000`, the `NotificationsProvider` `setInterval` idiom) calls `reviewInboxRoute` and counts `requests.filter(r => r.unread).length`. That count renders as a small pill on the Reviews nav item (via a new optional `badge?` on `ConsolePage` rendered inside `Shell.item()`, so the mechanism is reusable). Zero → no pill. The poll is best-effort (swallow errors). Opening the Reviews panel / a request clears unread server-side (`/review/get` marks-seen), so the next poll reflects it.

- [ ] Steps 1-5 (TDD): a test mocking `reviewInboxRoute` with 2 unread → the nav shows a "2" pill; mock 0 unread → no pill. Keep the poll interval injectable/short in the test to avoid a 45s wait (e.g. read `REVIEW_POLL_MS` from a module const the test can stub, or trigger one manual poll). Commit — `feat(review-ui): unread badge on the Reviews nav item (slow poll)`.

> Implementer note: `Shell.item()` currently has no badge slot and `ConsolePage` has no badge field — this is NEW surface (per recon). Add the optional `badge?` field to the contract, render it in `item()` next to the title, and drive it from the poller. Keep it optional so no other page is affected.

---

## Task 5: Full console suite + PR

- [ ] **Step 1:** `pnpm -C packages/console exec vitest run` — all console tests green (the new ones + existing). `pnpm -C packages/console exec tsc --noEmit` (or the console typecheck script) clean. Also run the console build if there's a `build.test.ts` gate.
- [ ] **Step 2:** Push `feat/review-ui`, open a PR against `main` titled "feat: gem review staging — console UI (Plan 2b)". Body: the Studio button + Reviews inbox + badge; note it completes Plan 2 atop the merged 2a routes; **note console tests are NOT in CI** so they were run locally; list the follow-ons (game play-in-inbox, group management UI, badge cadence tuning). End with the Co-Authored-By line.
- [ ] **Step 3:** Watch CI (`test (24)` — it won't run the console tests, but must stay green), merge `--rebase --delete-branch` once green; verify each commit landed on `origin/main`.

## Self-Review

- **Spec coverage:** §2 author side (Request-review button + status chip → Task 1), reviewer side (inbox + install-to-test + comment + approve/changes → Tasks 2-3); §3 badge (Task 4). ✓
- **Reuse:** identity gate + version resolution reused from Studio (Task 1); Watch fetch-list + NotificationsProvider poll idioms reused (Tasks 2, 4); the 3-edit page registration (Task 2). ✓
- **Placeholder scan:** the route bodies/responses must be verified against the merged `src/review.controller.ts` (flagged in each task) — not guessed. ✓
- **CI caveat:** console tests aren't in CI — Task 5 runs them locally and the PR body says so. ✓

## Follow-ons (deferred)
1. Game/miniapp gems → route install-to-test to the miniapp **player** (play the staged game) instead of a workspace install.
2. Group create/manage UI in the console (create native group, mint/redeem invites).
3. Badge poll cadence tuning / a cheaper unread-count endpoint if `/review/inbox` polling proves heavy.
4. A web (marketplace SPA) "approve from your phone" surface (spec follow-on #2).
