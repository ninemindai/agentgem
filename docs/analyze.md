# Analyze: workflow-aware Gem recommendation

Picking which skills, MCP servers, and hooks belong in a Gem is hard when a project
has dozens installed and you only really use a handful. **Analyze** does it for you:
it reads your agent's **session history** for a project, sees which artifacts you
actually invoked, and recommends ready-to-build Gems grouped by the workflows you
keep repeating.

Instead of a flat checklist of everything you have, you get a short list of
candidate Gems — each a coherent recurring flow ("code review", "web scraping",
"diagram generation") — and one click pre-selects exactly the artifacts it contains.

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

Only artifacts that exist in your real inventory are ever named — the scan is the
source of truth, so a recommendation can't invent a skill you don't have. Artifacts
that show up in transcripts but aren't installed are surfaced separately as **gaps**
("used but not in inventory").

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
