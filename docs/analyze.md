# Analyze: workflow-aware Gem recommendation

Picking which skills, MCP servers, and hooks belong in a Gem is hard when a project
has dozens installed and you only really use a handful. **Analyze** does it for you:
it reads your agent's **session history** for a project, sees which artifacts you
actually invoked, and recommends ready-to-build Gems grouped by the workflows you
keep repeating.

Instead of a flat checklist of everything you have, you get a short list of
candidate Gems — each a coherent recurring flow ("code review", "web scraping",
"diagram generation") — and one click pre-selects exactly the artifacts it contains.

Analyze also does something the inventory alone can't: it **distills brand-new
skills** from the work you did *by hand*. A lot of your expertise never becomes an
installed artifact — it lives in the raw `Bash → Edit → test → commit` procedure you
repeat across sessions. Analyze recovers those recurring procedures and proposes them
as **draft skills** you can review and fold straight into the Gem. See
[Distilled skills](#distilled-skills) below.

## Run an analysis

Open the testbed dialog (**Create / open testbed…** in the header). Every recent and
discovered project shows an **Analyze** button. Click it and AgentGem streams its
progress live:

> Scanning session history… → Scanned 12 transcripts, 30 sessions. Asking Claude… →
> Clustering Gems from your usage… → Validating against your inventory…

When it finishes you get one or more **candidate Gems**, each with a name, a short
rationale, and the artifacts it includes (with the reason each was chosen — e.g.
"5 uses across 3 sessions"). Press **"Switch & apply this Gem ▸"** to adopt that
project as your testbed and pre-check exactly that Gem's artifacts — then refine the
selection by hand if you like and build as usual.

Below the candidates, any **distilled skill drafts** appear in their own section — new
skills synthesized from your recurring hand-work, each with an **Add to build** and a
**write SKILL.md only** action. See [Distilled skills](#distilled-skills).

## What it reads

Analyze is grounded in a deterministic **transcript scan** before any AI is involved:

- It finds the Claude Code transcripts whose working directory matches the project
  (under `~/.claude/projects/`), matched by the recorded cwd, not the folder name.
- It counts **tool calls** to detect what fired: `Skill(...)` invocations, `mcp__*`
  tool calls (MCP servers), hook markers, and the project's instructions
  (`CLAUDE.md`). Each artifact gets an invocation count, how many distinct sessions
  it appeared in, and recency.
- It records which artifacts **co-occur** in the same session, which is how a single
  project gets split into multiple workflow candidates rather than one big bundle.
- For distillation, it also keeps each session's **builtin tool procedure** in order,
  passed through a **field-aware scrubber** ([`packages/insight/src/scrub.ts`](redaction.md)) that
  keeps only a structural slice per tool (a command's verb, a file path) and **drops
  everything else** — file contents, pasted prompts, secrets — before the procedure
  is ever stored or sent to the agent.

Only artifacts that exist in your real inventory are ever *named* in a recommendation —
the scan is the source of truth, so it can't invent a skill you don't have. (Distilled
skills are the deliberate exception: they're brand-new drafts, gated behind review, not
recommendations of installed artifacts.) Artifacts that show up in transcripts but
aren't installed are surfaced separately as **gaps** ("used but not in inventory").

## How the recommendation is made

The scan summary is handed to **Claude** (run locally over the
[Agent Client Protocol](https://agentclientprotocol.com/)) in read-only **plan
mode**, in a neutral working directory so it never pollutes the project's own session
history. Claude clusters the usage into 1–4 candidate Gems and explains each. Its
output is then **validated against your inventory** — any name it didn't get exactly
right is dropped.

If Claude is unavailable, times out, or returns nothing usable, Analyze **degrades
gracefully** to a deterministic recommendation built straight from usage frequency
(marked *agent unavailable*). It never throws and never fails silently — you always
get a recommendation.

Candidates are labelled by confidence: **high** when Claude proposed the grouping,
**medium** for the deterministic fallback.

## Distilled skills

The recommendation above only ever names artifacts you already have. But the actual
*how* — the procedure that got the task done — usually isn't an installed skill at
all; it's the sequence of builtin tool calls (`Bash`, `Edit`, `Read`, `Write`) that
the recommendation throws away. **Distillation** recovers it.

Alongside the deterministic scan, Analyze keeps the **ordered, redacted builtin
procedure** for each session and finds the runs that **recur across sessions** — not
whole sessions (those are never identical) but the shared sub-patterns, e.g.
`Edit → git add → vitest → git commit`. A second local Claude agent runs
**concurrently** with the recommender and turns each recurring procedure into a draft
skill, named and scoped by the **mission** it accomplished (drawn from the session's
opening task and outcome) rather than by its tools.

Each draft is a complete `SKILL.md` — frontmatter (`name`, `description`, `triggers`,
`tools`, `mutating`) plus a body of **Contract → Phases → Output Format** that
reproduces the steps the agent followed. Drafts are validated the only way unverified
content can be: structurally (kebab name, real triggers, a body), for **uniqueness**
(a draft never collides with an installed skill), and by **evidence-grounding** (every
tool it claims must actually appear in the captured procedure). A draft that fails is
dropped; if nothing recurs, you simply get no drafts.

A distilled skill is a **draft, never an install.** In the results you can:

- **Add to build ▸** — fold the draft into the Gem you're assembling. It's bundled
  with its full body and a reviewable `SKILL.md` is written under
  `~/.agentgem/distilled/<name>/`.
- **write SKILL.md only** — just save the draft to `~/.agentgem/distilled/<name>/`
  to edit and promote into `.claude/skills/` yourself, on your terms.

Nothing is ever written into your `.claude/skills/` automatically — the body is
agent-authored prose, so it stays behind a human review gate. Once you promote a
draft, the next Analyze sees it as a real installed skill and tracks its usage like
any other: the loop closes.

## Caching and re-analyzing

Results are cached per project (keyed to your transcript files), so reopening a
project shows the previous recommendation instantly — marked **cached**. When your
sessions change, the cache invalidates automatically. To force a fresh run, use the
**↻ Re-analyze** button.

## Where it fits

Analyze is an optional on-ramp to the [testbed flow](testbed-and-run.md): a fast way
to answer "what did I actually build here, and what's worth turning into a Gem?" You
can analyze a project without adopting it, or apply a recommendation and jump
straight into building. Everything after the recommendation — building, publishing,
merging, deploying — is the normal Gem flow.
