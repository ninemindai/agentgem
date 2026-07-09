# Miniapp Builder Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Play Studio agent a complete miniapp authoring contract — rules, host capability protocol, security model, source data, privacy, traps — replacing the four-sentence `studioInstructions()`.

**Architecture:** One canonical TypeScript string constant, `MINIAPP_BUILDER_BRIEF` in `packages/play/src/builderBrief.ts`. It is inlined into the Studio agent's first-turn brief by `studioInstructions()`, and mirrored byte-for-byte into `skills/agentgem-miniapp/SKILL.md` for humans and the skills.sh CLI. A drift-guard test asserts the markdown file ends with the constant, so the markdown can never fork from the string.

**Tech Stack:** TypeScript (ESM, NodeNext), pnpm workspaces, vitest.

Spec: `docs/superpowers/specs/2026-07-08-miniapp-builder-skill-design.md`.

## Global Constraints

- Branch `feat/miniapp-builder-skill`, worktree `../agentgem-miniapp-skill`, based on `origin/main` @ `bf9f5d1c`. Never commit to `main`.
- Play tests live in root `src/play/__tests__/` and import from the **built package** `@agentgem/play` (they run against `dist`). Do **not** add a package-local `vitest.config`.
- Because tests run against `dist`, every focused test run must be preceded by `npx tsc -b`.
- Frontmatter must start on **line 1** of `SKILL.md` — a leading comment hides the skill from the skills.sh CLI (see `src/distill/__tests__/shareSkill.test.ts`).
- `MINIAPP_BUILDER_BRIEF` is written as a TypeScript template literal. It contains many markdown backticks; **every backtick inside the literal must be escaped as `` \` ``**. It contains no `${` sequences, so no `$` escaping is needed.
- Do not modify the runtime: `mcpUiHost.ts`, `mcpHostTools.ts`, `Runner.tsx`, `gameGate.ts`, `portability.ts` are all out of scope.
- Full-suite runs in a fresh worktree require `node scripts/build-console.mjs` first, or `consoleMount.test.ts` fails for unrelated reasons.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/play/src/builderBrief.ts` | **Create.** The canonical contract text. Nothing else — no I/O, no imports. |
| `packages/play/src/index.ts` | **Modify** (after line 12). Export the constant so root tests and consumers can import it from `@agentgem/play`. |
| `skills/agentgem-miniapp/SKILL.md` | **Create.** Frontmatter + `# agentgem-miniapp` heading + the identical body. |
| `src/play/__tests__/builderBrief.test.ts` | **Create.** Drift guard + content guards. |
| `packages/play/src/studio.ts:47-55` | **Modify.** `studioInstructions()` composes the per-miniapp line with the constant. |
| `src/play/__tests__/studio.test.ts:29-36` | **Modify.** Assert the seeded brief carries the contract. |

Task 1 delivers the contract and its guard. Task 2 delivers it into the agent's hands. A reviewer can accept Task 1 and reject Task 2 independently.

---

### Task 1: The canonical brief + its markdown mirror

**Files:**
- Create: `packages/play/src/builderBrief.ts`
- Create: `skills/agentgem-miniapp/SKILL.md`
- Modify: `packages/play/src/index.ts` (add one export line after line 12)
- Test: `src/play/__tests__/builderBrief.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const MINIAPP_BUILDER_BRIEF: string` from `@agentgem/play`. Task 2 imports it from `./builderBrief.js`.

- [ ] **Step 1: Write the failing test**

Create `src/play/__tests__/builderBrief.test.ts`:

```ts
// src/play/__tests__/builderBrief.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MINIAPP_BUILDER_BRIEF } from "@agentgem/play";

const md = (): string => readFileSync(join(process.cwd(), "skills/agentgem-miniapp/SKILL.md"), "utf8");

describe("agentgem-miniapp skill", () => {
  it("is a skills.sh-discoverable skill file", () => {
    // frontmatter on line 1 — a leading comment hides the skill from the skills.sh CLI
    expect(md()).toMatch(/^---\nname: agentgem-miniapp\ndescription: \S/);
  });

  it("mirrors MINIAPP_BUILDER_BRIEF verbatim (drift guard)", () => {
    // SKILL.md is a VIEW of the constant: frontmatter + heading on top, body byte-identical below.
    expect(md().endsWith(MINIAPP_BUILDER_BRIEF)).toBe(true);
  });

  it("names every host tool the miniapp can call", () => {
    for (const tool of [
      "agentgem_get_session_data",
      "agentgem_get_inventory",
      "agentgem_subscribe_sessions",
      "agentgem_invoke_agent",
    ]) expect(MINIAPP_BUILDER_BRIEF).toContain(tool);
  });

  it("teaches the notification subscription that shipped broken once", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("ui/notifications/tool-result");
    expect(MINIAPP_BUILDER_BRIEF).toContain("subscribe by METHOD, never by tool name");
  });

  it("states the seal, the capability declaration, and the redaction boundary", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("default-src 'none'");
    expect(MINIAPP_BUILDER_BRIEF).toContain("needs");
    expect(MINIAPP_BUILDER_BRIEF).toContain("redactForBake");
  });

  it("says invoke-agent is read-only", () => {
    expect(MINIAPP_BUILDER_BRIEF).toContain("read-only");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ../agentgem-miniapp-skill && npx tsc -b
```

Expected: `tsc` FAILS with `error TS2305: Module '"@agentgem/play"' has no exported member 'MINIAPP_BUILDER_BRIEF'.`

- [ ] **Step 3: Create the canonical brief**

Create `packages/play/src/builderBrief.ts`. **Every markdown backtick below is escaped as `` \` `` because this is a template literal.**

```ts
// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// The authoring contract handed to the Play Studio agent on its first turn (see studio.ts
// studioInstructions) and mirrored, byte-for-byte, into skills/agentgem-miniapp/SKILL.md for humans
// and the skills.sh CLI. This module is the single source of truth; the markdown is a view of it, and
// src/play/__tests__/builderBrief.test.ts fails if the two drift apart.
//
// The Studio agent's cwd is jailed to ~/.agentgem/miniapps/<name>/ (studioCwd), so it cannot read this
// repo — the contract has to be PUSHED into the brief. chatSession.ts injects the brief on the first
// turn only, so length here is a one-time cost, not a per-turn tax.
//
// Pure string. No imports, no I/O.

export const MINIAPP_BUILDER_BRIEF = `## The file

You are editing one file: \`<name>.html\` — a single, self-contained HTML document. Never add a
second file. If the file has \`AGENTGEM:GAME-LOGIC\` start/end markers, keep your changes between
them.

It runs in a **null-origin sandboxed iframe** (\`sandbox="allow-scripts"\`, no \`allow-same-origin\`)
under this Content-Security-Policy:

    default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
    img-src data:; font-src data:; media-src data:;

So inline every byte of JS and CSS, use only \`data:\` URIs for images, fonts and media, and make no
network calls of any kind.

## What Save enforces

Two gates run when the user saves. Both throw a message you will see in the studio.

**The seal.** Rejects, anywhere in executable code:

- an external \`src=\` or \`href=\` (anything other than \`data:\` or \`#\`)
- a bare module import (\`import … from "…"\`)
- the words \`fetch\`, \`XMLHttpRequest\`, \`WebSocket\`, \`EventSource\`, \`importScripts\`,
  \`navigator.sendBeacon\`

That last check is a plain regex over your code, and **it matches inside comments and string literals
too**. If you need to write about fetching, choose another word rather than fight the gate. Data
inside \`<script type="application/json">\` is exempt, so baked source data is safe. The bundle must
also stay under 1.5 MB and must not throw while loading.

**Portability.** If you declare the \`session-data\` capability, the file must also bake a non-empty
\`timeline\` into \`<script id="game-data">\`. app.agentgem.ai plays games with no host at all —
without baked data your published game would sit empty forever.

## Your source data

The miniapp is seeded from a session, a skill, or a project. That source is injected as an inert JSON
blob in \`<head>\`, so it has already parsed by the time your script runs:

    const data = JSON.parse(document.getElementById("game-data").textContent);

| seeded from | genre | shape of \`game-data\` |
| --- | --- | --- |
| a coding session | \`replay\` | \`{ meta, timeline: [{ role, tsMs, text }] }\` — at most 500 turns, each \`text\` cut to 200 characters |
| a skill | \`skill-run\` | the skill's name, description and content |
| a project | \`project-fun\` | the project's name and inventory counts |
| an import, or blank | \`project-fun\` | no \`game-data\` at all |

**Always boot from the baked data, then re-render if fresher data arrives.** Never block your first
paint on a host — there may not be one.

## Talking to the host

You have no network. When you need live data the host fetches it for you and hands it over
\`postMessage\`, which the Content-Security-Policy does not govern. That is exactly why a sealed
miniapp can still be interactive.

The wire is MCP Apps \`ui/*\` JSON-RPC. A client shim is already injected into your \`<head>\`; use it,
do not write your own.

    // one-shot
    const inv = await window.agentgemApp.callTool("agentgem_get_inventory", {});

    // streamed — subscribe by METHOD, never by tool name
    window.agentgemApp.onNotification("ui/notifications/tool-result", ({ toolName, chunk }) => {
      if (toolName === "agentgem_subscribe_sessions") render(chunk);
    });

    window.agentgemApp.ready       // has the handshake completed?
    window.agentgemApp.hostTools   // what the host offered, filtered to what you declared

Dispatching on \`params.toolName\` instead of on the method silently drops every host push. That bug
shipped once. Do not reintroduce it.

Declare the capabilities you use in \`meta.json\` as \`"needs": ["…"]\`:

| capability | tool | gives you | costs the viewer |
| --- | --- | --- | --- |
| \`session-data\` | \`agentgem_get_session_data\` | your own source session, \`{ meta, timeline }\` | nothing — auto-approved |
| \`local-project-access\` | \`agentgem_get_inventory\` | their skills, MCP servers and projects | a consent prompt |
| \`live-session-events\` | \`agentgem_subscribe_sessions\` | their live coding-session events, streamed | a consent prompt |
| \`invoke-agent\` | \`agentgem_invoke_agent({ message })\` | one agent turn, transcript streamed back | a consent prompt |

An undeclared capability fails with JSON-RPC \`-32601\`. A refused consent fails with \`-32001\`. With
no host at all the handshake gives up after roughly four seconds and every \`callTool\` rejects with
\`"no host"\`. Handle all three: a game that hangs waiting for a host is broken on the marketplace.

Editing \`meta.json\` takes effect on the next Save; reload the preview to renegotiate.

## What you must not assume

- **The seal gate is not a security boundary**, it is an admission check. The
  Content-Security-Policy and the null origin are the boundary. Do not probe either.
- **The host does not trust you.** It checks each message came from your frame, re-checks every call
  against your declared \`needs\`, ignores any \`sessionId\` you pass to
  \`agentgem_get_session_data\` (only the user can rebind the session), permits one live stream and
  one agent turn at a time, and drops replies meant for a game that has since been swapped out.
- **\`invoke-agent\` is read-only.** It opens a neutral agent turn with edit permission denied. It
  cannot change files or run commands. Do not tell the user otherwise.
- **Storage is a lie.** \`localStorage\` and \`sessionStorage\` are an in-memory shim, installed only
  because a null-origin document throws on the real thing. State dies on reload. Do not promise a
  high-score table that survives.

## Privacy

Whatever you bake into this file ships. Saving writes a \`game\` gem, and "Share to app.agentgem.ai"
makes it public to anyone.

The seed data was already scrubbed by \`redactForBake\`: the home directory replaced with \`~\`, and
OpenAI, GitHub, AWS, Slack and JWT token shapes replaced with \`‹redacted›\`. That is best-effort, not
a guarantee. So:

- Never write an absolute home path, a username, a hostname, or a key-shaped string into the file.
- Do not render raw transcript text the game does not need. Ask what the game is *for*, and show that.
- A gated capability reads the **viewer's** machine, not yours. The consent prompt is blunt on purpose
  — "run a local AI agent on your machine". Declare one only when the game is pointless without it.

## Traps that have already cost days

- Lay out full-window: \`html, body { height: 100%; overflow: hidden }\` and
  \`#stage { position: fixed; inset: 0 }\`.
- **Never measure the viewport once.** Listen for \`resize\`. A one-shot measurement at parse time is
  the single most common bug here: the frame can be born small, and going fullscreen changes the real
  viewport underneath you.
- Do not poll for the host. The shim already retries the handshake about five times over four seconds,
  and queues any \`callTool\` you make before it is ready.
- A canvas game takes three to five seconds to first paint. A blank frame right after load is usually
  slow paint, not a bug. Wait before you debug.
- Stay well under 1.5 MB.

## Finishing

The user drives this. **Save** runs both gates. **Push to git** commits the registry. **Share to
app.agentgem.ai** publishes the gem. If Save fails, read the gate message and fix the file — the
console also offers "Fix with agent", which sends the failure straight back to you.
`;
```

- [ ] **Step 4: Export the constant**

In `packages/play/src/index.ts`, add after the existing `studio.js` export (line 12):

```ts
export { MINIAPP_BUILDER_BRIEF } from "./builderBrief.js";
```

- [ ] **Step 5: Create the markdown mirror**

Create `skills/agentgem-miniapp/SKILL.md`. It is exactly: frontmatter, a blank line, the `# agentgem-miniapp` heading, a blank line, then the **verbatim body** of `MINIAPP_BUILDER_BRIEF` (unescape the `` \` `` back to plain backticks).

The file therefore begins:

```markdown
---
name: agentgem-miniapp
description: Use when building or editing an AgentGem miniapp / mini-game — the sealed, single-file HTML app under ~/.agentgem/miniapps/. Covers the seal, the host capability protocol, consent, privacy, and the sizing traps.
---

# agentgem-miniapp

## The file

You are editing one file: `<name>.html` — a single, self-contained HTML document. Never add a
```

…and continues, unchanged, through the final line of the constant:

```markdown
console also offers "Fix with agent", which sends the failure straight back to you.
```

The constant ends with a trailing newline (the template literal's closing backtick sits on its own
line), so `SKILL.md` must also end with exactly one trailing newline for `endsWith` to hold.

To generate it mechanically rather than by hand, and guarantee the drift guard passes:

```bash
cd ../agentgem-miniapp-skill && npx tsc -b && mkdir -p skills/agentgem-miniapp && node -e '
const { writeFileSync } = require("node:fs");
import("./packages/play/dist/index.js").then(({ MINIAPP_BUILDER_BRIEF }) => {
  const fm = [
    "---",
    "name: agentgem-miniapp",
    "description: Use when building or editing an AgentGem miniapp / mini-game — the sealed, single-file HTML app under ~/.agentgem/miniapps/. Covers the seal, the host capability protocol, consent, privacy, and the sizing traps.",
    "---",
    "",
    "# agentgem-miniapp",
    "",
    "",
  ].join("\n");
  writeFileSync("skills/agentgem-miniapp/SKILL.md", fm + MINIAPP_BUILDER_BRIEF);
});
'
```

(`node -e` runs CommonJS by default, so `require` works and `import()` is the dynamic form needed to
reach the ESM build. The joined frontmatter ends with two newlines, giving exactly one blank line
before the brief's opening `## The file`.)

Verify the head of the file is right — frontmatter must be on line 1:

```bash
head -8 skills/agentgem-miniapp/SKILL.md
```

Expected: `---` on line 1, `name: agentgem-miniapp` on line 2.

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd ../agentgem-miniapp-skill && npx tsc -b && npx vitest run src/play/__tests__/builderBrief.test.ts
```

Expected: PASS, 6 tests.

If `mirrors MINIAPP_BUILDER_BRIEF verbatim` fails, the markdown drifted — regenerate it with the
Step 5 command rather than hand-patching either side.

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-miniapp-skill
git add packages/play/src/builderBrief.ts packages/play/src/index.ts skills/agentgem-miniapp/SKILL.md src/play/__tests__/builderBrief.test.ts
git commit -m "feat(play): the miniapp authoring contract, as a skill and a brief

One canonical string in packages/play/src/builderBrief.ts, mirrored to
skills/agentgem-miniapp/SKILL.md under a drift-guard test. Covers the seal,
the host capability protocol, the security model, source data, privacy, and
the sizing traps. Not yet wired into the studio brief.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Deliver the contract to the Studio agent

**Files:**
- Modify: `packages/play/src/studio.ts:47-55` (the `studioInstructions` function)
- Test: `src/play/__tests__/studio.test.ts` (extend the existing `seedStudio` test)

**Interfaces:**
- Consumes: `MINIAPP_BUILDER_BRIEF` from `./builderBrief.js` (Task 1).
- Produces: nothing new. `studioInstructions` stays module-private; `seedStudio`, `importStudio`, `blankStudio` and `studioBrief` all call it and pick the change up unchanged.

- [ ] **Step 1: Write the failing test**

In `src/play/__tests__/studio.test.ts`, find the `seedStudio` test whose body ends around line 36 with
`expect(brief).toContain(name);`. Add these three assertions directly beneath it:

```ts
    expect(brief).toContain(`${name}.html`);                       // the per-miniapp line survives
    expect(brief).toContain("ui/notifications/tool-result");       // the full contract is inlined
    expect(brief).toContain("agentgem_invoke_agent");
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd ../agentgem-miniapp-skill && npx tsc -b && npx vitest run src/play/__tests__/studio.test.ts
```

Expected: FAIL — `expected '…' to contain 'ui/notifications/tool-result'`. The first assertion
(`${name}.html`) already passes; the other two do not.

- [ ] **Step 3: Rewrite `studioInstructions`**

In `packages/play/src/studio.ts`, add the import beside the other local imports (after line 14):

```ts
import { MINIAPP_BUILDER_BRIEF } from "./builderBrief.js";
```

Then replace the whole function at lines 47-55:

```ts
function studioInstructions(name: string): string {
  return (
    `You are building the miniapp in ${name}.html (edit ONLY that file). It must stay a single ` +
    `self-contained, SEALED HTML file: inline all JS/CSS, use only data: URIs, and make NO network calls ` +
    `(no fetch/XHR/WebSocket/external src/href/import). Replace the block between the ` +
    `"AGENTGEM:GAME-LOGIC" markers. Read the JSON in <script id="game-data"> for the source content. ` +
    `The file must run without throwing on load.`
  );
}
```

with:

```ts
// The full authoring contract, injected on the agent's first turn only (chatSession.ts nulls the brief
// afterwards). The leading line names THIS miniapp; everything below it is the shared contract, which
// also ships as skills/agentgem-miniapp/SKILL.md.
function studioInstructions(name: string): string {
  return `You are building the miniapp in ${name}.html.\n\n${MINIAPP_BUILDER_BRIEF}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd ../agentgem-miniapp-skill && npx tsc -b && npx vitest run src/play/__tests__/studio.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify no existing contract broke**

These three tests pin behaviour the change must preserve — the brief still names `<name>.html`, the
blank-studio prompt is still threaded through, and the seeded HTML still carries the edit markers.

```bash
cd ../agentgem-miniapp-skill && npx vitest run \
  src/play/__tests__/studio.test.ts \
  src/play/__tests__/builderBrief.test.ts \
  src/__tests__/chatStudio.test.ts \
  src/__tests__/playRoutes.test.ts \
  src/goldmine/__tests__/chatRoutes.test.ts
```

Expected: PASS, all files.

- [ ] **Step 6: Run the full suite**

The console SPA must be built first or `consoleMount.test.ts` fails for reasons unrelated to this change.

```bash
cd ../agentgem-miniapp-skill && node scripts/build-console.mjs && pnpm test
```

Expected: PASS. If `consoleMount.test.ts` still fails, confirm it also fails on a clean `origin/main`
checkout before investigating.

- [ ] **Step 7: Commit**

```bash
cd ../agentgem-miniapp-skill
git add packages/play/src/studio.ts src/play/__tests__/studio.test.ts
git commit -m "feat(play): hand the studio agent the full authoring contract

studioInstructions() was four sentences covering only the seal. It now composes
the per-miniapp line with MINIAPP_BUILDER_BRIEF, so seedStudio, importStudio,
blankStudio and studioBrief all deliver the rules, the host capability protocol,
the security model, the privacy boundary, and the sizing traps.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Finishing

Push the branch and open a PR (the default integration path — CI gates `test (24)` and `test (26)`):

```bash
cd ../agentgem-miniapp-skill && git push -u origin feat/miniapp-builder-skill
gh pr create --title "feat(play): the miniapp authoring contract, as a skill and a studio brief" --body "$(cat <<'BODY'
`studioInstructions()` was four sentences covering only the seal — the agent that writes every miniapp never learned about `window.agentgemApp`, `needs`, consent, `redactForBake`, the ephemeral storage shim, or the one-shot-viewport bug.

This adds `MINIAPP_BUILDER_BRIEF` (canonical, `packages/play/src/builderBrief.ts`), inlines it into the studio brief, and mirrors it to `skills/agentgem-miniapp/SKILL.md` under a drift-guard test.

Spec: `docs/superpowers/specs/2026-07-08-miniapp-builder-skill-design.md`
Plan: `docs/superpowers/plans/2026-07-08-miniapp-builder-skill.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Then `gh run watch <run-id> --exit-status`, and only once green `gh pr merge --rebase --delete-branch`.
The local-branch delete step will error because `main` is checked out in another worktree — the remote
merge still succeeds. Afterwards, `git fetch` and confirm **both** commits landed on `origin/main`:

```bash
git fetch origin
git show origin/main:packages/play/src/builderBrief.ts | head -1   # commit 1
git show origin/main:packages/play/src/studio.ts | grep MINIAPP_BUILDER_BRIEF   # commit 2
```

Both must print. A merge that drops the second commit is the known trap in this repo.
