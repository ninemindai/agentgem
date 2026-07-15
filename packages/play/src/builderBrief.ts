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

**Theming.** The host may supply CSS variables — \`--color-background-primary\`,
\`--color-background-secondary\`, \`--color-text-primary\`, \`--color-border-primary\` — and sets \`theme\`
(\`"light"\` or \`"dark"\`) on \`<html data-theme>\` automatically. Read them with a fallback, because most
hosts send none: \`background: var(--color-background-primary, #0d1117)\`. On app.agentgem.ai, and any
other host that sends no variables, the fallback is what renders.

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
\`timeline\` into \`<script id="game-data" type="application/json">\`. app.agentgem.ai plays games with
no host at all — without baked data your published game would sit empty forever.

## Your source data

The miniapp is seeded from a session, a skill, or a project. That source is injected as an inert JSON
blob in \`<script id="game-data" type="application/json">\` in \`<head>\`, so it has already parsed by
the time your script runs:

    const data = JSON.parse(document.getElementById("game-data").textContent);

If you bake or re-bake this data yourself, keep the \`type="application/json"\` attribute — it is what
exempts the block from the seal's network-word scan, so dropping it fails Save on ordinary words inside
your data.

| seeded from | genre | shape of \`game-data\` |
| --- | --- | --- |
| a coding session | \`replay\` | \`{ meta, timeline: [{ role, tsMs, text }] }\` — at most 500 turns, each \`text\` cut to 200 characters |
| a skill | \`skill-run\` | the skill's name, content and trigger |
| a project | \`project-fun\` | the project's path, flavor and notable file names |
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

Editing \`meta.json\` takes effect on the next Save, which re-reads it and renegotiates the preview's
host with the new capabilities. There is no separate reload.

**Save reconciles \`needs\` against your code.** Call a tool you did not declare and the Save fails,
naming the capability to add. Declare a capability nothing calls and it is pruned back out, and you are
told. So \`needs\` can never drift from what the miniapp actually does.

Pass every tool name as a **literal string** — \`callTool("agentgem_get_inventory")\`, never
\`callTool(name)\`. The reconciler reads your source; a name it cannot see is a capability it prunes,
and your call would then fail at play time with \`-32601\`. So the Save rejects a non-literal name
outright. Naming a tool inside a comment or a string is fine — only a real call is checked.

\`window.agentgemApp\` also exposes action methods beyond \`callTool\`. Same rule applies: write the
method name as a **literal** on \`agentgemApp.\` — Save derives your declared capabilities from the
source and cannot see an aliased reference.

- \`agentgemApp.openLink(url)\` opens an external link. The host asks the user every time and shows the
  URL. Returns a promise.
- \`agentgemApp.sendMessage({ role, content })\` and \`agentgemApp.updateModelContext({ structuredContent })\`
  speak into, or push structured state into, the host's conversation. These only work in an external
  chat host (for example Claude Desktop) that rendered the miniapp — in the AgentGem console, and on
  app.agentgem.ai, they reject with "unsupported by this host"; catch that rejection and degrade
  gracefully rather than treating it as a bug. Declaring either one is local-only: never call them from
  a miniapp you intend to share or publish.
- \`agentgemApp.requestDisplayMode("fullscreen")\` (or \`"inline"\`) requests a display change. The host
  may refuse, so its reply names the mode it actually applied, and it then pushes fresh
  \`containerDimensions\` via a \`ui/notifications/host-context-changed\` notification. Re-read your
  layout from those dimensions rather than measuring the scaled frame yourself.

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

Whatever you bake into this file ships. Saving writes a \`game\` gem, and "Share" (publishes to
app.agentgem.ai) makes it public to anyone.

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
- **Register every \`onNotification\` handler before your first render.** The host can push a
  \`tool-input\` or a \`tool-result\` immediately after the handshake completes, and a handler wired up
  after your first frame paints misses it.
- A canvas game takes three to five seconds to first paint. A blank frame right after load is usually
  slow paint, not a bug. Wait before you debug.
- Stay well under 1.5 MB.

## Finishing

The user drives this. **Save** runs both gates. **Push to git** commits the registry. **Share**
publishes the gem to app.agentgem.ai. If Save fails, read the gate message and fix the file — the
console also offers "Fix with agent", which sends the failure straight back to you.
`;
