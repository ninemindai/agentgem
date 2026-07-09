# Sharing & identity

Beyond the GitHub-backed [registry](registry.md), AgentGem gives you two lighter ways
to move a Gem to someone else — a one-command **install** from the marketplace, and a
direct, **encrypted hand-off** — plus the GitHub **identity** that signs your work and
gates publishing, and a **verify** command to check a Gem runs across agents.

## `agentgem get` — install a published Gem

```bash
agentgem get <key>[@<version>]        # e.g. agentgem get research-assistant@1.2.0
npx @ninemind/agentgem get <key>@<v>  # the one-liner shown on every marketplace gem page
```

Downloads a published Gem from the marketplace and imports it as a local workspace,
with **zero config** — no registry setup, no browser, no running server. If you don't
pin a version it resolves the latest. The archive's `gem.lock` is verified on import,
so a tampered download is rejected.

Flags:

- `--version <v>` — pin a version (same as `<key>@<version>`).
- `--yes` / `-y` — import even if the Gem carries **executable** artifacts (MCP
  servers or hooks). Without it, a Gem that contains executables is *not* imported
  silently: AgentGem lists the MCP servers and hooks it would install and stops, so
  you can look before you run.
- `--endpoint <url>` — point at a different marketplace API (default
  `$AGENTGEM_AGGREGATOR_URL`, else `https://api.agentgem.ai`).

## `agentgem send` / `receive` — an encrypted hand-off

To pass a Gem straight to one person without publishing it, encrypt it and stash it
over a broker for a single pickup:

```bash
agentgem send my-gem.gem              # → prints a one-time ticket
agentgem receive <ticket> [out.gem]   # fetches, decrypts, verifies, and burns it
```

`send` encrypts the `.gem` bytes **client-side** (AES-256-GCM), signs them with your
[identity](#github-identity), and stashes the ciphertext over NATS store-and-forward.
It prints a ticket shaped like:

```
agentgem://gem/<bucket>/<object>#<key>[~<producer>]
```

The **decryption key lives only in the ticket's URL fragment** — it's never sent to
the broker, which only ever holds ciphertext. `receive` pulls the object, decrypts it
with the key from the ticket, verifies the archive's `gem.lock` **and** the sender's
signature, writes the `.gem`, and **burns the stashed object after the first
successful pickup**. Hand the ticket to one person over any channel; it works once.

Both ends read `NATS_URL` (default `nats://127.0.0.1:4222`) and optional `NATS_TOKEN`
from the environment for the broker connection.

> The transfer ticket `agentgem://gem/…` is a *different* thing from the marketplace
> `agentgem://get-gems?…` deep link below — same scheme, different payloads. One
> carries an encrypted one-time object; the other asks an installed app to search or
> install a *published* Gem.

## "Open in AgentGem" deep links

Every gem page on [app.agentgem.ai](https://app.agentgem.ai) has an **Open in
AgentGem** button that hands the Gem to your local console over the `agentgem://`
protocol:

- an installable Gem → `agentgem://get-gems?install=<key>&v=<version>`, which triggers
  a **consent-gated** zero-config install (the modal defaults to *Cancel* — a website
  can't install a Gem behind your back);
- a browse-only Gem → `agentgem://get-gems?q=<key>`, which just pre-searches the Get
  Gems screen.

The [desktop app](desktop.md) registers the `agentgem://` scheme with your OS, so the
button launches or focuses the app and jumps to the right screen — regardless of the
random local port the app is on. When you're running over `npx`, the same links work
through a `http://localhost:4317/#/get-gems?…` fallback.

## GitHub identity

Publishing and sharing are tied to a **GitHub identity** so the network can tell one
real author from a hundred throwaway accounts. Bind this machine's signing key to your
GitHub account once:

```bash
agentgem bind
```

It runs the GitHub **device flow** — open the printed URL, enter the code — then
signs a payload and registers your public key with the aggregator. Your raw GitHub
token is never written to disk; what's stored locally is a binding record and a
first-party session (`~/.agentgem/binding.json`, `~/.agentgem/session.json`, both
`0600`). On success: `✓ bound to github:@you`.

> **Publish or share a Gem at least once before binding.** Binding attaches your
> identity to a producer the network already knows about; if it's never seen you, it
> returns `unknown-producer` and asks you to publish or share first.

In the console, the same identity shows as a **chip in the shell footer**: **Sign
in** when you're unbound, or **@you** with your GitHub avatar when you're bound.
Clicking it opens a sign-in modal (the device flow, in place) when signed out, or —
when signed in — opens **app.agentgem.ai already authenticated**, via a one-time
handoff code. Flows that need identity (like publishing a mini-game from
[Play → Studio](play.md)) let you connect inline and then pick up right where you left
off.

## `agentgem verify` — does it run everywhere?

A Gem is meant to be runtime-neutral. `verify` proves it by running the Gem's contract
across the coding agents you have installed and printing a compatibility matrix:

```bash
agentgem verify <archive-dir> [--agents claude,codex] [--fetch]
```

- `--agents <list>` restricts the roster to specific agents.
- `--fetch` resolves inputs the contract needs.

Each agent reports `✓ passed`, `✗ failed` (with the failing check), or `– unavailable`,
followed by a summary. It exits `0` when every *available* agent passed, `1` on any
failure or if nothing was available, and `2` on a usage or contract error — so it
drops cleanly into CI.
