# TODOS

Deferred work, with enough context to pick up cold.

## Theme-wide: muted small-text contrast is below WCAG 4.5:1

**What:** Decide whether `--muted` (#8a7f69) on `--raised` (#fbf7ee) at 11–12px —
used for `obs-usage-count`, legends, metadata lines across the Observe dashboard —
should be darkened (e.g. toward `--ink-soft`) or the small-text sizes bumped.

**Why:** WCAG AA wants ≥4.5:1 for body-size text; the muted-on-raised pair sits
below that. Flagged during the 2026-07-16 design review of the Overview
token-breakdown cards, but it's a theme convention, not a per-card issue — fixing
one card would fork the design language.

**Pros:** One token change fixes contrast everywhere at once; keeps every card
consistent.

**Cons:** Darkening `--muted` changes the whole page's texture — the warm
letterpress look depends on the quiet metadata layer; needs a designer's eye pass,
not a mechanical swap.

**Context:** Tokens in `packages/console/src/shell/theme.css:14` (`--muted`) and
the `obs-*` rules around line 1040. Verify candidate values against both `--paper`
and `--raised` backgrounds.

**Depends on / blocked by:** Nothing. Theme-level decision.

## Null-project ("Unassigned") filterability on Observe

**What:** Teach `ObserveFilter`/`aggregateObserve`/the project `<select>` a
`project: null` value so the "Unassigned" bucket in "Tokens by project" becomes
clickable like every other row.

**Why:** Deferred from the 2026-07-16 token-breakdown design review (decision 9A):
today "Unassigned" renders as an honest non-link. If a user's sessions are mostly
projectless, their top spender is a row they can't drill into.

**Pros:** Removes the one dead end in the token-attribution flow.

**Cons:** Touches shared filter plumbing (`ObserveFilter` type, `aggregateObserve`
filter application, `ObserveFilters` select) also used by Sessions; a sentinel
value for "null" needs care in the select's empty-string convention.

**Context:** Filter application at `packages/insight/src/observeAggregate.ts:86`;
select at `packages/console/src/panels/Observe/ObserveControls.tsx:31-35`. Only do
this if the Unassigned bucket proves dominant in real usage.

**Depends on / blocked by:** The token-breakdown cards shipping first.

## Key federated membership on GitHub's numeric user id, not the login string

**What:** Add `gh_user_id` to `org_members` and match accounts on
`accounts.provider_account_id` (which already stores GitHub's numeric id) instead of
`lower(accounts.login)`.

**Why:** GitHub logins are mutable. A member who renames their GitHub account becomes
unmatchable: `accountIdForLogin('oldname')` returns null, the `member_removed` webhook
for their old login silently no-ops, and their `via_sync` grant goes stale. An
offboarded member who renamed keeps group access until their captured scopes expire.

**Pros:** Removes the last mutable-string join from the membership path.
`provider_account_id` is already stored and already unique per provider.

**Cons:** `org_members` is populated from GitHub's roster API; changing it means a
backfill and a webhook payload change. Same debt the `account_identities` split will
confront anyway.

**Context:** Two call sites — `accountIdForLogin` in
`packages/aggregator/src/groupsFederation.ts`, and the `member_added` / `member_removed`
branches in `src/githubApp/sync.ts:95-102`. Target key is `accounts.provider_account_id`
(`packages/aggregator/src/schema.ts:81`). Surfaced by the Codex outside voice during the
2026-07-08 eng review of the groups plan. Mitigating factor: it self-heals on the
member's next sign-in, because `captureOrgMemberships` re-materializes their grant under
the new login.

**Depends on / blocked by:** Nothing blocking. Naturally belongs with the
`account_identities` sequel, which re-keys identity anyway.

## Fix the catalog cookie-only Bearer gap

**What:** `catalog/install.ts` resolves the session from the cookie only, while every
sibling public route (`orgsApi`, `usage`, `groups`, etc.) accepts either a session
cookie or `Authorization: Bearer` via `resolveSession`. So the CLI cannot call
`DELETE /api/catalog/gem` (or the catalog reads) with a Bearer token.

**Why:** A real inconsistency bug on an auth path — the CLI can publish/unpublish
everywhere except catalog. The fix is one line: route catalog's session lookup through
`resolveSession(auth, req.headers)` like the others (add a regression test:
`DELETE /api/catalog/gem` with a Bearer token → 200).

**Pros:** Closes a documented bug; makes the catalog auth surface uniform with its
siblings; ~one-line change plus a test.

**Cons:** Widens catalog's accepted auth (cookie → cookie|Bearer). Intended, but must be
tested so it's owned, not accidental.

**Context:** The CORS/`preflight`/type-shim dedup half of this (originally "shared
routeKit") shipped as Fix 1 — `src/publicCors.ts`, PR #371. The *controller migration*
that would have folded this in (Fix 3) was reviewed and SHELVED on 2026-07-12
(`docs/superpowers/specs/2026-07-12-public-api-framework-migration-design.md` — the
framework-native path breaks the flat `{error:"..."}` envelope). So this Bearer bug is
now a standalone fix, not blocked on any migration.

**Depends on / blocked by:** Nothing. Its own small PR.

## Author a console DESIGN.md (design-system doc)

**What:** Write DESIGN.md for `packages/console` documenting the theme.css token
system (`--ink`/`--paper`/`--accent`/`--line`), the `play-*` component vocabulary,
and surface rules (e.g. one terracotta primary per surface; segmented control for
single-choice groups; visible labels, placeholder is a format hint only).
`/design-consultation` can drive it.

**Why:** The 2026-07-15 Studio toolbar design review had to reverse-engineer the
design system from theme.css. A DESIGN.md lets future design reviews calibrate
against stated rules instead of inference.

**Pros:** Faster, more consistent design reviews; "one primary per surface" becomes
written law instead of oral tradition; onboarding aid.

**Cons:** ~an hour of documentation; risks staleness if not maintained.

**Context:** Flagged during /plan-design-review of
`docs/superpowers/specs/2026-07-15-studio-toolbar-declutter-design.md`. The token
system already behaves like a design system; it's just undocumented. The 2026-07-16
app-redesign design review produced a token-pinned visual spec for the reveal screen
(app-redesign-proposal §3.7, in agentgem-biz) — use it as seed content, including the
muted-ink contrast rule (`--muted` fails 4.5:1 at body sizes on paper; body text uses
`--ink-soft`).

**Depends on / blocked by:** Nothing.

## Multi-instance connectors (connector type vs installed gem instance)

**What:** Let a miniapp declare a connector TYPE and let the viewer bind which installed
`mcp_server` gem instance satisfies it (alias/binding UI + a `selection_required`-style
pending state), instead of the manifest hard-naming one gem.

**Why:** Real users run two Slack workspaces or work+personal GitHub. v1 mcpNeeds
name-address a single installed gem, so a second instance needs a differently-named gem
the miniapp can't reach without editing its manifest.

**Pros:** Unlocks multi-account reality; the mirrored claude.ai contract already sketches
the UX (`selection_required`, per-view name binding via an additive options hint — never
per-call resolution).

**Cons:** A binding layer, per-viewer state, and selection UI — real scope for a need no
user has voiced yet.

**Context:** From the Codex outside voice during the 2026-07-15 eng review of the miniapp
MCP connectors design (finding #10). v1 ships name-addressed manifests with hash-pinned
consent (D9); `server_not_connected` copy should hint at the install/rename workaround.
Evolution path: additive options hint narrowing the single per-view name binding, exactly
as the claude contract documents its own future.

**Depends on / blocked by:** MCP connectors v1 (model + console consent). Nothing else.

## Marketplace install-time connector disclosure (read/action badges)

**What:** Persist tool annotation hints (readOnlyHint/destructiveHint) alongside mcpNeeds
at publish so game cards can show "GitHub — 3 read tools" vs "Slack — posts messages"
before install, not just the connector-name chip.

**Why:** Install-time is when users weigh risk (Codex outside-voice finding #14); the v1
chip names connectors but not whether the app only reads or can act.

**Pros:** Honest risk signal at the decision moment; the watch-gate work (D11) already
plumbs annotations at runtime — this persists them at publish.

**Cons:** Annotations are UNVERIFIED connector self-description captured at author time;
they can drift from the viewer's actual gem. Must be framed advisory, never authoritative.
Publish wire schema grows.

**Context:** From the 2026-07-15 eng review of the miniapp MCP connectors design. v1
covers the security moment with the run-time consent card (lists declared tools); this is
the v1.1 install-time enrichment. Beware treating author-time hints as verified data.

**Depends on / blocked by:** MCP connectors PR-1 (publish wire schema) + D11 annotation
handling.

## Test the MCP connection manager's http/sse transport branches

**What:** Add an in-process HTTP MCP server fixture and a test exercising
`mcpConnectors.ts`'s `StreamableHTTPClientTransport` / `SSEClientTransport` branches.
While there, wrap `new URL(config.url)` so an invalid connector URL surfaces as
`server_unavailable`, not the generic-tail `tool_error`.

**Why:** Spec §7 lists an http-transport fixture at the manager layer; PR-2 shipped
stdio-only (the demo/E2E path). The http/sse branch is a thin lazy pass-through to the
SDK constructors, so it's low-risk, but it's a real spec-listed coverage item and the
URL-error mislabel lives on that same untested path.

**Pros:** Closes the §7 gap; proves the http connector path before a real http connector
gem ships. **Cons:** Needs an in-process Streamable-HTTP MCP server harness (the SDK
provides `StreamableHTTPServerTransport`, as mcpProxy.ts already shows).

**Context:** Flagged by the PR-2 final whole-branch review (2026-07-16, PR #454) as
ride-to-PR-4. `packages/play/src/mcpConnectors.ts` http/sse branch. Natural home: PR-4,
alongside the Repo Pulse demo + verify-skill E2E.

**Depends on / blocked by:** Nothing. Belongs with PR-4.

## Instrument the first-run funnel metrics (wow < 60s · first gem < 3 min)

**What:** Emit timing events for the two design-reviewed success metrics of the app
redesign: time-to-reveal-rendered (target < 60s) and time-to-first-gem (target < 3 min),
plus the fire-gate outcome (reveal vs "prospecting" fallback).

**Why:** The redesign's success criteria were split into two instrumented metrics during
the 2026-07-16 design review (the old single "< 60s" test failed arithmetic — distill
alone is ~50s). Without events, P0 can't prove the wow works or catch cold-scan latency
regressions on real histories.

**Pros:** Makes the redesign's core promise measurable; catches slow-cold-scan
regressions; cheap (local timing, no telemetry plane needed — log lines suffice for v1).

**Cons:** Small scope creep on P0; needs a decision on where timings land (local log vs
usage reporter).

**Context:** From /plan-design-review of agentgem-biz/strategy/app-redesign-proposal.md
(finding: the 60-second success test conflated reveal-time with gem-time). The metrics
are defined in the proposal §3.5/§7.

**Depends on / blocked by:** P0 reveal implementation.

## Lift the scorecard's 12-recent-projects discovery cap

**What:** Remove or raise the silent cap in `src/gem/scorecard.ts:33` that limits goldmine
discovery to the 12 most recent projects, or make it configurable with an incremental scan.

**Why:** The redesigned reveal presents scorecard numbers as the user's goldmine; the cap
undercounts heavy users' actual history. P0 ships an honest scope label ("across your 12 most
recent projects" — eng review 2026-07-16), but the right fix is scanning everything.

**Pros:** Trophy numbers become true globally; removes a caveat from the product's signature
screen.

**Cons:** Unbounded scan cost on large histories — needs the incremental/cached scan path to keep
the <60s reveal budget; cap exists for a reason today.

**Context:** Outside-voice (Codex) catch during /plan-eng-review of the app-redesign proposal.
The reveal's subline labels the scope until this lands.

**Depends on / blocked by:** P0 reveal (ships with the label); scorecard cache/incremental scan.

## Server-side wedged-turn watchdog for chat sessions

**What:** A core-side timeout in `ChatManager` that detects a turn whose agent
`prompt()` never resolves (hung agent process) and force-fails it, releasing
`running` so every client recovers without the user pressing Stop.

**Why:** The Studio resume live-progress work (PR #469) makes a running turn
visible and keeps Stop as the guaranteed recovery, and its degraded label admits
when the server is unreachable — but a genuinely wedged agent still holds the
chat's `busy` lock until a human intervenes. Both the eng review and the Codex
outside-voice pass flagged this as the last remaining permanent-lock class.

**Pros:** Closes the wedged-turn lock at the source; benefits every client
(console today, any future tab/attach consumers), not just Studio.

**Cons:** Touches `chatSession.ts`'s background-completion guarantee (R1) — the
riskiest core code; timeout semantics need care because long turns are
legitimate (a naive cap would recreate the old give-up bug server-side).

**Context:** `packages/run/src/chatSession.ts:151-166` — `sendMessage` bridges
`prompt()` push-callbacks into the event generator and awaits `settled`; a
watchdog would race an inactivity timer (no delta/tool events for N minutes)
against that promise, then dispose the handle so the `finally` at :171-173
releases `running`. Land after PR #469's transcript-poll UX proves out.

**Depends on / blocked by:** Nothing hard; sequence after the Studio resume
live-progress implementation PR.

## Chat queue: persist queued messages across reloads

**What:** Persist each composer's `queued[]` (see `packages/console/src/panels/chatQueue.tsx`)
per miniapp/chat in `studioChatStore` (localStorage), restore on mount, and let the
resume-poll completion path fire it — completing the walk-away story: queue a correction,
close the laptop, come back, it sent.

**Why:** The queue is in-memory (v1 cut, documented in
`docs/superpowers/specs/2026-07-20-chat-queue-interrupt-design.md`): a reload drops
queued chips. The 2026-07-20 eng review confirmed the resume-poll path now fires the
queue (issue 1), so persistence is the one missing piece for reload survival.

**Pros:** Typed intent survives crashes/reloads; symmetric with the durable chat
sessions (#469) story.

**Cons:** localStorage sync across tabs introduces a two-writers wrinkle (last-write-wins
is probably fine for drafts); needs a "queued for a dead session" answer if the chat was
killed while unloaded (eng review issue 9 chose clear-on-kill — mirror it on restore).

**Context:** `useMessageQueue` in `panels/chatQueue.tsx` is the single home for queue
logic (both composers consume it). Persistence belongs inside the hook so both surfaces
get it at once. `studioChatStore.ts` already has the per-miniapp keyed-storage pattern
to mirror.

**Depends on / blocked by:** Nothing — issue-1 (resume firing) and issue-2 (shared hook)
landed with the 2026-07-20 eng-review fix PR.

## gameGate smoke: reuse a warm worker instead of spawning one per call

**Where the code lives:** `packages/miniapp-gate/src/gameGate.ts` — the gate moved out of
`@agentgem/play` into its own published package (PR #551). The caller that makes this hurt is
still `packages/play/src/miniapps.ts`; `@agentgem/play` re-exports the gate, so its call sites
did not change.

**What:** Keep one long-lived smoke worker (or a `gateMany()` batch entry point) so jsdom
is imported once per process rather than once per `gameGate()` call, respawning the worker
after a spin or OOM kills it.

**Why:** Moving the smoke into a worker (PR #550) traded per-call cost for containment.
Measured on Node 24 / jsdom 29, 20 sequential calls on the same small bundle:

| | total | per call |
|---|---|---|
| main-thread (pre-#550) | 395ms | 20ms |
| worker (post-#550) | 5956ms | 298ms |

Nearly all of the 278ms delta is jsdom being re-imported in a fresh worker; the old path
paid that once and hit the ESM module cache after. Interactive Save is unaffected in
practice (298ms behind a user action with a preview render after it). The path that hurts
is `migrateAllMiniapps` (`packages/play/src/miniapps.ts:284`), which loops the whole
registry and gates each entry at `:307` — N x 20ms becomes N x 298ms, so 50 miniapps goes
from ~1s to ~15s and 200 from ~4s to ~60s.

**Pros:** Recovers most of the regression on the registry-wide pass while keeping the
containment that makes the worker worth having (spin, OOM, and async-escape isolation).

**Cons:** Lifecycle management is the whole cost — respawn after terminate, and an argument
for why residue from a previous bundle cannot affect the next smoke in a shared worker.
A `gateMany()` batch API avoids the shared-state question but adds a second gate entry
point that has to stay behaviorally identical to `gameGate()`, which is its own trap.

**Context:** Do NOT solve this by reverting to the main thread. The worker is what makes
three failure classes survivable, one of which has no in-process mitigation at all: a
synchronous `while(true)` blocks the event loop so no handler runs, and in a server that
stops health checks responding. See `gameGate.ts` §"THE SMOKE RUNS IN A WORKER THREAD" and
the 2026-07-21 `new Path2D(...)` crash the file records. Benchmark method that matters:
verify which code is loaded (`grep -c worker_threads` on the built file) before trusting a
before/after number — an earlier measurement of this compared the new code against itself
and reported no regression.

**Depends on / blocked by:** Nothing. PR #550 landed the containment; this is pure
optimization on top.

## `packages/play/src/__tests__/ember.test.ts` compiles but never runs

**What:** Bring workspace-package tests into the vitest `include` list, or move the ones
that matter under root `src/`. Then actually run `ember.test.ts` and fix whatever it says.

**Why:** `vitest.config.ts:5` includes `dist/**/__tests__/**/*.test.js`,
`packages/app/dist/**`, `packages/fabric/dist/**`, and `website/edge/**`. It does NOT
include `packages/play/dist/**`. `ember.test.ts` therefore compiles to
`packages/play/dist/__tests__/ember.test.js` on every build and is never executed. The
suite has been reporting green without it for as long as the include list has looked like
this.

The second-order problem is worse than the dead test: anyone adding a test beside a
workspace package gets a file that silently never runs, and nothing in the output says so.
This was nearly repeated during PR #551 — the new `@ninemind/miniapp-gate` tests were
placed under root `src/play/__tests__/` specifically to dodge it.

**Pros:** Recovers real coverage (EMBER is a built-in miniapp served as a constant, so a
regression there ships straight to users), and removes a trap that silently discards
future tests.

**Cons:** The test has not run in a while, so it may well be red — budget for fixing it,
not just for wiring it up. Widening the glob to `packages/*/dist/**` also pulls in any
other dormant test files at once, which is the same surprise in bulk.

**Context:** Found during the /plan-eng-review of PR #551 while deciding where to put new
tests. Verify the current state with `npx vitest run --reporter=basic 2>&1 | grep -ci ember`
— it returns 0 today while `packages/play/dist/__tests__/ember.test.js` exists on disk.
Note `packages/play` keeps `jsdom` + `@types/jsdom` as devDependencies purely so this file
typechecks during `pnpm build`; that is the only reason those entries are still there.

**Depends on / blocked by:** Nothing. Best done as its own PR — the wiring is one line, the
fallout is not.

## Publish smoke: `pnpm pack` + temp install for `@ninemind/miniapp-gate`

**What:** Pack the package into a tarball, install it into a temp directory, and import it.
Assert the entrypoint resolves and the gate surface is callable.

**Why:** `src/play/__tests__/miniappGate.package.test.ts` covers the cheap half — `files`
contains dist, every declared `exports` path exists as a built artifact, and the built
entrypoint really re-exports the surface. It cannot cover the part that only a real
install exercises:

- `workspace:^` actually being rewritten to a real semver range at publish time;
- a runtime dep present in the workspace but missing from the tarball;
- install-time resolution failure on a consumer machine.

This matters more than usual because `@ninemind/miniapp-gate` is the first package in this
repo published for an external consumer. Everything else here is `private: true` or the
root CLI, so no existing test has ever needed to care whether a tarball installs.

**Pros:** Turns "the published package works" from an assumption into a check, before a
second host depends on it.

**Cons:** Slowest test in the suite by a wide margin (pack + install is seconds, not
milliseconds), so it wants its own CI job or a tag rather than a place in the default run.

**Context:** Raised by the Codex outside voice during the /plan-eng-review of PR #551, which
correctly noted that importing through the pnpm workspace symlink resolves the SOURCE tree
and therefore proves nothing about publishing. The cheap half landed in that PR; this is the
half deliberately left out.

**Depends on / blocked by:** Nothing.

## Bundler: replace implicit externality with an explicit allowlist

**What:** Stop deriving esbuild's `external` list from `Object.keys(pkg.dependencies)`
(`scripts/bundle-bins.mjs:34`). Declare an explicit external/bundled allowlist, and add a
test asserting the built bundle contains no forbidden bare imports.

**Why:** Today, which package.json section a dependency sits in silently controls what the
published CLI artifact looks like. Moving an entry between `dependencies` and
`devDependencies` — an edit that reads as pure metadata — flips a module between
compiled-in and externally-resolved, with no signal at review time and no test that would
catch it.

This is not hypothetical: PR #551 hit it in both directions. Adding
`@ninemind/miniapp-gate` to `dependencies` made it external and quietly introduced a
publish-ordering rule (external deps must already be on npm or a fresh install fails);
moving it to `devDependencies` inlined it again. Both were one-line edits that looked
like dependency housekeeping.

**Pros:** Makes a load-bearing build decision explicit and reviewable, and a bundle
assertion catches the failure at CI rather than at a user's `npm i -g`.

**Cons:** The current scheme has worked for months and encodes a real invariant (a
package that resolves its own files at runtime, like jsdom, must stay external). An
allowlist has to preserve that or it trades a subtle failure for a louder one.

**Context:** Raised by the Codex outside voice during the /plan-eng-review of PR #551. The
existing comment block at `scripts/bundle-bins.mjs:24-46` documents the current rules and
is the right place to start — it already explains why jsdom is a root dependency despite
only `@agentgem/play` importing it.

**Depends on / blocked by:** Nothing, but it is a change to the publish contract — worth
doing when someone is already touching release tooling rather than on its own.

## No eval harness for the LLM criterion judge prompt

**What:** Build a small eval suite for `packages/insight/src/criterionJudge.ts`'s prompt —
fixture sessions with known-correct applicability and fire verdicts, run against the real
agent, scored for agreement.

**Why:** The applicability change (2026-07-30) makes the prompt carry more weight: it now
asks the judge for a per-session not-applicable roster on top of the fire decision, and
the roster feeds a denominator users read as a number. Unit tests only verify the parser
against synthetic responses. Nothing verifies that the model actually produces good
rosters, so prompt regressions land silently and show up as quietly wrong denominators.

**Pros:** Turns the one untested surface in the rubric pipeline into a measured one, and
gives a baseline for the "does asking two questions per pair degrade fire accuracy?"
question the review flagged at 5/10 confidence but could not answer.

**Cons:** Needs a real agent to run, so it is slow, costs tokens, and is non-deterministic —
it cannot gate CI the way the unit tests do. Fixture sessions must be scrubbed before they
can live in the repo.

**Context:** Raised during the /plan-eng-review of the criterion-applicability design
(`docs/superpowers/specs/2026-07-30-criterion-applicability-design.md` §9, "Not covered by
tests"). The judge already has a stubbable seam — `evaluateRubric` takes `opts.judge` and
`judgeCriteria` takes `opts.connectFn` — so an eval driver can reuse it without new
plumbing. `judgeSession.ts` has the same untested-prompt gap and would share the harness.

**Depends on / blocked by:** Ships after the applicability change; the prompt contract
should settle first.

## Agent Plugin import: product entry point + safe tar extraction

**What:** Wire `readAgentPlugin()` (packages/archive) into a user-facing import
surface — most likely a SourceSpec adapter next to the existing multi-agent
source adapters — including hardened tar extraction for untrusted plugin
archives (reject `..`/absolute entries, symlink escapes, size bombs).

**Why:** The 2026-08-07 Agent Plugins alignment ships the library seam only;
`importGem()` (packages/distribute/src/share.ts) still requires gem.json/gem.lock,
so a foreign plugin is not importable through any product path yet. The Codex
outside-voice review flagged the goal/delivery gap explicitly.

**Pros:** Every published Agent Plugin (Google Agents CLI, Data Agent Kit, ARD
catalog) becomes minable/gradeable AgentGem inventory — the import direction is
the strategically valuable one for a find/mine/share product.

**Cons:** Untrusted-archive handling is security-sensitive; needs its own review
(existing archiveTar was built for self-produced archives, not hostile input).

**Context:** `readAgentPlugin` lands in packages/archive/src/agentPlugin.ts
(plan: docs/superpowers/plans/2026-08-07-agent-plugins-alignment.md, Task 6).
Import-time path sanitization of skill sibling files is already in that task;
the tar layer is what remains. Spec decision recorded in
docs/superpowers/specs/2026-08-07-agent-plugins-alignment-design.md.

**Depends on / blocked by:** The alignment PR landing first.

## ARD / AI Catalog discovery feed for the marketplace

**What:** Evaluate consuming Agentic Resource Discovery (ARD) and the AI Catalog
(`application/agent-plugins+json` media type) as a discovery feed, surfacing
external Agent Plugins in the AgentGem marketplace as import candidates.

**Why:** Google/Amazon/Microsoft/OpenAI/Vercel/Cursor are standardizing plugin
packaging + discovery; being an early conformant *indexer* positions the
marketplace as the place where plugins get graded/verified, which is AgentGem's
moat (trust + effectiveness data, not hosting).

**Pros:** Inventory growth without authoring; rides the gem-grade/verify
pipeline unchanged once import (above) exists.

**Cons:** Spec layers are young (1.0.0, June-2026 era); indexing half-baked
feeds could import junk — needs curation gates.

**Context:** Announcement: developers.googleblog.com/agent-plugins-package-your-skills-tools-and-more/;
spec: agent-plugins.org/specification. Vendored schemas live in
src/gem/__tests__/fixtures/agentPluginSchemas.ts after the alignment PR.

**Depends on / blocked by:** Agent Plugin import entry point (above).

## Detached external loads escape both the static scan and the digest

**What:** Instrument resource-loading setters and constructors (`Image`, `Audio`,
`HTMLElement.prototype.src`, `link.href`) inside the smoke worker so a
`new Image().src = "https://…"` load is detected.

**Why:** Flagged as the one critical gap in the 2026-08-07 eng review of the
render-verification gate. `staticGate`'s own comment concedes the source scan
misses it, and the post-execution digest misses it too because the element is
never attached to the DOM. For miniapps the runtime CSP (`default-src 'none'`)
still blocks it, so this is contained. For **reports**, which are served with no
CSP, it is undetected and unmitigated: a report could phone home when opened.

**Pros:** Closes the last known silent self-containment hole; makes
`attachedExternal` honest rather than partial.

**Cons:** Patching globals inside `SMOKE_WORKER_SRC` grows the untypechecked
eval'd string that file explicitly asks to keep small. Needs care so the patches
cannot be defeated by the bundle re-assigning the same globals.

**Context:** `packages/miniapp-gate/src/gameGate.ts` — the `beforeParse(window)`
hook already installs canvas stand-ins, so there is an established place to hang
this. See "Failure modes" in
`docs/superpowers/specs/2026-08-05-render-verification-gate-design.md`.

**Depends on / blocked by:** The digest producer (T2) should land first so the
two mechanisms report through one `Finding` shape.

## No trustworthy settle condition, so blank-render stays a warning

**What:** Replace the smoke's two `setTimeout(0)` ticks with a bounded quiet
period (drain timers and `requestAnimationFrame`, cap the wait), then promote
`blank-render` from `warn` to `fail`.

**Why:** The 2026-08-07 eng review demoted `blank-render` specifically because
two ticks is not a rendering contract — a document that paints on rAF or a
delayed timer looks blank when the worker snapshots. That makes the check unsafe
as a gate, so a genuinely blank report still ships with only a warning. Codex
raised this independently as finding 7.

**Pros:** Promotes the highest-value report check to an actual gate; also makes
every other digest field more reliable, since they all read the same snapshot.

**Cons:** Any wait lengthens the gate, which runs on every miniapp Save and once
per entry in `migrateAllMiniapps`. Needs a cap so a slow bundle cannot stall a
registry-wide pass, and the cap reintroduces the same false-negative in the tail.

**Context:** `packages/miniapp-gate/src/gameGate.ts:205-206` is the current
two-tick settle. Baseline cost is ~300ms warm / ~520ms cold per entry; canvas
games are documented as taking 3-5s to first paint, so a naive "wait for paint"
is not viable.

**Depends on / blocked by:** T2 and T4 (digest producer and check set).

## Tier 2: real-browser layout and contrast checks

**What:** A `renderCheck(html, viewports)` test helper driving headless Chrome as
an optional devDependency, plus a CI job over fixtures — one golden report, one
golden miniapp — at 360 / 390 / 1440 across four theme states.

**Why:** Deferred from the 2026-08-07 eng review, which scoped that pass to Tier
1.5. jsdom has no layout engine, so page-level horizontal overflow, clipping, and
computed contrast are structurally undetectable there. This is the tier that
would automate the narrow-viewport screenshots currently taken by hand.

**Pros:** Catches the class of bug being checked manually today (text wrapping at
360px, light/dark contrast on generated documents). Also gives deterministic
template output — `renderRpgTheme`, `scaffolds.ts`, `ember.ts` — somewhere to be
tested.

**Cons:** Adds a browser dependency and a CI job. Must be skipped when the
browser is absent so local `pnpm test` never breaks, and must never reach the
published tarball.

**Context:** Full design intent preserved under "NOT in scope" in
`docs/superpowers/specs/2026-08-05-render-verification-gate-design.md`. Checks
that need layout: `documentElement.scrollWidth > clientWidth`, interactive-target
clipping, and computed contrast on every distinct surface (text inheriting the
body colour inside a tinted region is the failure mode).

**Depends on / blocked by:** Nothing — shares no code with Tier 1.5.

## Gemit card: two gold-on-gold / gold-on-cream contrast failures

**What:** Recolour two pairs in `renderRpgTheme` so 12px text reaches WCAG AA
(4.5:1). Today: `#e8c87d` on `#d9a441` is **1.39:1** (the "N pt from <tier>"
line), and `#d9a441` on `#f0eee6` is **1.94:1** (the stat numerals).

**Why:** Found by the Tier 2 render check the first time it ran, on the exact
artifact that was being screenshotted by hand at 360/380. It fires at every width
and in every theme, so it is a palette choice rather than a layout bug. 1.39:1 is
gold-on-gold — effectively unreadable, not merely tight.

**Pros:** The card is the most-shared AgentGem artifact; unreadable numerals on a
share card are worth more than the fix costs.

**Cons:** The gold-on-gold pair IS the card's visual identity. Darkening the
foreground or the plate changes its character, so this needs a designer's eye,
not a mechanical contrast bump. Consider raising the type size instead — at 24px
the large-text threshold drops to 3:1, which `#d9a441` on cream nearly meets.

**Context:** `src/gemit/themeRpg.ts`. The pairs are pinned in
`src/__tests__/renderCheckFixtures.test.ts` by distinct colour pair, so these two
are tolerated and a THIRD fails immediately — the debt is bounded, not laundered.
Update that expectation when the palette changes.

**Depends on / blocked by:** Nothing. Independent of the Tier 2 harness itself.
