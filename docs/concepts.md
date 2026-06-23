# Concepts

## What a Gem is

A **Gem** is a portable, secret-safe snapshot of a slice of your coding-agent config —
the skills, MCP servers, and `CLAUDE.md` you chose to bundle. It's the unit AgentGem
produces and the neutral source that every deploy target and the registry consume. You
build it once; everything downstream reads from it.

A Gem is intentionally *not* tied to any one runtime. The same Gem can be installed back
into a local testbed, merged with other Gems, published to the registry, or compiled to a
deploy target — without rebuilding from your raw config each time.

## The archive format (manifest + lock)

On disk a Gem serializes as an archive with two parts:

- a **manifest** — the human-meaningful declaration of what the Gem contains (its name,
  the selected skills, MCP server shapes, whether `CLAUDE.md` is included), and
- a **lock** — the resolved, pinned detail that makes a build reproducible.

Keeping the manifest and lock separate is what lets Gems compose: merging two Gems means
reconciling manifests and re-resolving a single lock, rather than diffing opaque blobs.

## The redaction trust boundary

AgentGem's core safety rule: **secrets are redacted at capture.** The moment config is
read, MCP secrets are stripped — both by value and by key name (anything that looks like a
key, token, or password). Redaction happens *before* anything crosses a boundary, so every
REST response, every MCP tool result, the live preview in the UI, and the built Gem all
carry only redacted shapes — never raw secret values.

Serving this over HTTP and MCP doesn't weaken the boundary: it's the same redaction the
original CLI enforced. Secrets stay on your machine; what leaves is a config *shape* with
`<redacted>` in place of every sensitive value.

## The AgentBack one-contract model

AgentGem is built on **AgentBack**, ninemind's AI-native API/MCP framework. Each operation
— `inventory`, `gem` — is defined once as a Zod contract. From that single definition
AgentBack derives:

- a **REST endpoint** (what the web page calls),
- an **MCP tool** (what your local agent calls),
- an **OpenAPI 3.1** document plus a Swagger `/explorer`, a typed client, and runtime
  validation with machine-actionable error envelopes.

The payoff is coherence: there's no second schema to drift out of sync. A tool is not a
re-implemented endpoint — it's the same contract surfaced at a different boundary. The web
UI is just one client of that contract.

Continue to **[Targets & deploy](targets.md)** to see where a Gem can go.
