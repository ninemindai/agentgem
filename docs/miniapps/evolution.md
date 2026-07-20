# Miniapps: decisions and lessons from building with an AI agent

Companion to [`spec.md`](spec.md). The spec is the normative "what"; this file is
the "why it ended up that way" — the key decisions, and the lessons from the
building experience itself: a human steering and an AI coding agent implementing,
in a spec-driven loop, over roughly two weeks (2026-07-06 → 2026-07-19). Commit
hashes are citations; the design specs and plans referenced live under
[`docs/superpowers/specs/`](../superpowers/specs/) and
[`docs/superpowers/plans/`](../superpowers/plans/).

## How it was actually built: the SDD loop

Every non-trivial miniapp feature followed the same loop, visible in the commit
record:

1. **Brainstorm → design spec** — a dated `*-design.md` under
   `docs/superpowers/specs/` (e.g. the MCP Apps cutover `aa6e3519`, connectors
   `29e258c7`, uploads `a4425494`).
2. **Eng review of the spec, folded back in** — review findings amend the spec
   *before* code exists (`da955d73` "eng review — reference-first, gate-safe ship
   uploads"), sometimes with an **outside voice**: a second, different AI model
   reviewing the first one's plan (`a230d274` "7 issues + Codex outside voice").
3. **Implementation plan** — a dated task list under `docs/superpowers/plans/`,
   TDD-ordered, naming exact test commands and file paths.
4. **Implement, task by task** — the agent codes; review findings land as their
   own same-day commits (`0d5aa3ad`, `8f33b701`), not as silent amendments.
5. **Correct the spec against reality** — when implementation contradicts the
   spec, the spec is fixed and says so: `298654ba` "correct the spec against what
   implementation actually found."

That last step is the load-bearing one. The spec is an instrument for building,
not a monument; it stays authoritative *because* it loses arguments with the
implementation and is updated to admit it.

## The key decisions

**D1 — A miniapp is one sealed HTML file, and it is a Gem from day one.**
`GameArtifact` joined the gem artifact union in the very first commit
(`02c334f2`), before any UI existed. Making the new thing an instance of the
platform's existing first-class citizen — rather than a parallel media type —
meant publish, install, versioning, and sharing came almost for free later.

**D2 — The seal is an admission check; the sandbox is the security boundary.**
Decided (and documented) on day one (`f1d46445`): the save-time gate (no external
refs, no network words, 1.5 MB cap, load-smoke) exists to reject things that
*would not work* in the sealed frame — the null-origin iframe + CSP is what makes
them *safe*. Conflating the two is the classic mistake; naming the distinction
early kept the gate honest (a plain regex that matches comments is fine for
admission; it would be absurd as security).

**D3 — Versioning is git.** The registry (`~/.agentgem/miniapps/`) is a git repo;
every save, seed, and checkpoint is a commit (`49af9855`, `f2edac86`). No
version-number bookkeeping was ever built, and none was ever missed.

**D4 — Adopt the public MCP Apps protocol; kill the private bridge fast.** The
first live-data path was a private postMessage bridge (`f3a005db`). It survived
one day. The cutover to standard MCP Apps `ui/*` JSON-RPC — host tools, router,
injected client shim, migration for stored miniapps (`41f51989` → `e861d65f`) —
was done *before* the private protocol had accreted users. Because of this,
external MCP Apps hosts (e.g. Claude Desktop) can render miniapps unchanged.

**D5 — Declarations must be incapable of lying.** `meta.json`'s `needs` is not
documentation: Save *derives* capabilities from the HTML and reconciles —
undeclared call fails the save, unused declaration is pruned (`404a24e8`,
`2a696633`). This forced the literal-tool-name rule (`57ea5145`): the reconciler
reads source, so a computed name is invisible to it and is rejected outright.
Consent prompts and capability pills are trustworthy downstream because drift is
impossible upstream.

**D6 — Portability is gated, not hoped for.** The marketplace plays games with
*no host at all*, so a `session-data` game must bake a non-empty fallback
timeline or the save fails (`ea03ec36`). "Always boot from baked data, then
re-render if fresher data arrives" is enforced, not advised.

**D7 — The authoring contract ships as a skill the agent reads.** The rules of
miniapp authorship are a versioned artifact
([`skills/agentgem-miniapp/SKILL.md`](../../skills/agentgem-miniapp/SKILL.md)),
injected into the Studio agent's first turn (`87fbc74c`). The AI agent is a
first-class documentation audience; every later contract change landed *with* a
brief edit, because a stale brief is a production bug, not a docs chore.

**D8 — Consent is scoped to risk, and egress is special.** Read capabilities
prompt once per grant; the clipboard (`copy-command`, the first egress
capability) is consent-gated and deliberately **never remembered** (`4b9ba2a2`)
— egress is how a sealed game would exfiltrate. MCP connector consent is
**digest-pinned and fail-closed** (`9d5e5bc2`): approval binds to the exact
server/tool surface and dies when that surface changes.

**D9 — Artifacts leave the machine only by explicit opt-in.** Save is local: it
writes the registry and the gem on *your* disk. Every step outward is a separate,
deliberate act with its own scope: **Push to git** goes to a remote you
configured; **Share** publishes with a visibility you choose per publish —
Public / Unlisted / Private (`0a80a835`, `e4d52983`) — and confirms
overwrite-vs-new-version (`b6ef2986`); team collaboration is opt-in and scoped —
**request-review** stages the game to a group you pick (`ca2d08e3`), reviewers
play the staged copy in a sealed modal (`739a22e2`), and only an explicit
approval publishes. Nothing ships as a side effect of building. The bake-time
redaction (`redactForBake`) is best-effort hygiene; the opt-in gates are the
actual control, which is why the brief tells the agent to treat everything baked
into the file as shipped.

**D10 — Every widening pairs with a tightening.** The pattern repeats five times
across the history:

| widening (what miniapps gained) | tightening (what Save/host then enforced) |
| --- | --- |
| live host data | portability gate: baked fallback required |
| capability tools | needs derived + reconciled; literal names only |
| action methods (`agentgemApp.*`) | derived from method calls like tool needs |
| clipboard egress | consent never remembered |
| MCP connectors | digest-pinned, fail-closed consent |

A future PR that widens what a miniapp can do without a matching save-time or
consent-time tightening is, on this record, a design smell.

**D11 — Local-first (0.9.0).** The hosted service packages were removed from this
repo (`9d4e5166`, `da250782`); the miniapp engine (`packages/play`), the console
surfaces, and the authoring skill live here, and the hosted marketplace is
something this repo only talks to as a client.

## Lessons from the human ↔ AI building experience

**L1 — Spec first, but let the spec lose.** The specs made the agent's work
checkable, but the flow ran both directions: implementation findings amended the
spec the same day (`298654ba`, `c72cfa10`). What decayed instead were the specs
nobody corrected. Treat "the spec was wrong" as a normal, cheap outcome — it's
`docs:` commit-sized, not a crisis.

**L2 — Write contracts for the agent, in the agent's failure modes.** The
authoring brief doesn't read like API docs; it reads like a list of ways an AI
gets this wrong, stated imperatively: "Dispatching on `params.toolName` … silently
drops every host push. That bug shipped once. Do not reintroduce it." A trap that
cost a day gets a sentence in the brief; the sentence is what stops the *next*
agent session — which shares no memory with the last one — from repaying the cost.

**L3 — Make invariants machine-checked, not agreed upon.** Human-AI agreements
("declare what you use") don't survive session boundaries; save-time reconcilers
do (D5). The genre enum got a drift guard the same week it got a second consumer
(`5935055d`). When a rule matters, the collaboration's job is to move it from the
conversation into a gate.

**L4 — Review is a first-class phase, and a second model is a cheap second
opinion.** Review findings are named commits within hours of the feature
(`0d5aa3ad` "review finding", `8f33b701` "review hardening"), and plan reviews
sometimes ran an "outside voice" — a different AI model auditing the plan
(`a230d274`) — catching assumptions the authoring model was blind to.

**L5 — Plans must encode the environment's gotchas, or the agent re-trips on
them.** Plan amendments repeatedly fixed the same class of thing: vitest filters
on `dist/` paths not `src/` (`bc925330`), tests in the CI-gated root home
(`8e4a6535`, `2aba7d29`). Repo-specific mechanics that a human "just knows"
must be written into the plan text, because the agent executing task 5 has no
memory of the session that learned them in task 2.

**L6 — Prove the wire, not the units.** The MCP Apps conformance work was locked
by an end-to-end test proving the shim and host agree on `_meta` shapes
(`01d27958`). For protocol seams between components built in *different agent
sessions*, unit tests on each side passed while the wire was wrong; only the
end-to-end shape test caught it.

**L7 — Small eras, shippable daily.** The whole feature moved as one-day eras:
scaffold + gate + UI in a day, capabilities the next, cutover the next. Each era
ended in a mergeable state. Long-lived agent branches were never needed — and the
few times scope tried to grow mid-PR, it was split instead (the repo's
one-PR-one-scope rule exists because appending to a merged PR silently dropped
commits twice).
