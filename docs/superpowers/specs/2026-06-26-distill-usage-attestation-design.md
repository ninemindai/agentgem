# Distill Usage Attestation & Producer Path — Design (Spec A)

**Date:** 2026-06-26
**Status:** Approved design, pre-implementation

> **Amendment 2026-06-27 (from Spec B1 brainstorm — ingest substrate):** usage attestations are ingested via a **hosted ingest endpoint the producer POSTs to** (verified at the door), *not* by piggybacking on the GitHub registry push. Consequences for Spec A: (a) **account-attestation moves from "the commit author" to OAuth** (Sign in with Vercel / GitHub OAuth) performed at the ingest endpoint — the "free commit-author binding" in Decision 3 is **superseded**; (b) `sign_and_publish` **POSTs the signed attestation to the hosted ingest API** (the data-critical step) in addition to publishing the Gem archive to the registry **for distribution only**. The GitHub registry remains the durable, content-addressed *distribution* store for installable Gems; it is no longer the data-ingest path. See Decision 3, §The attestation envelope (`account`), and §MCP tool contracts (`sign_and_publish`).

> **Amendment 2026-06-26 (from Spec B/B1 brainstorm):** the envelope gains an **optional** `evidence.signal` — the *full redacted `WorkflowSignal`* the profile was derived from. It is **opt-in**: when omitted, `evidence.signalDigest` is a tamper-evident commitment only and the aggregator relies on cross-record statistical detection (baseline tier); when included, the aggregator deterministically recomputes counts and grants the record a **"verified" badge** (verified tier). `scrub.ts` must be airtight on the shipped signal since it carries more detail than the summary metrics. See §The attestation envelope, §MCP tool contracts (`build_attestation` gains `includeSignal?`), and §Privacy.
**Part of:** a three-subsystem vision — **A. Producer** (this spec), **B. Aggregator** (hosted leaderboard + usage graph + data API), **C. Trust spine** (anti-fraud + PageRank ranking). C is a constraint woven through A and B, not a standalone phase.

## North star

Priority order driving every trade-off in this spec:

1. **Data moat** (highest) — the cross-network *usage graph* is the product.
2. **Trust** — shared records must be hard to fake; a leaderboard of fakeable records is worthless.
3. **Acquisition / volume** (lowest for now) — frictionless adoption matters, but not at the cost of data fidelity or trust.

Spec A delivers the **producer side only**: a signed, scan-grounded *usage attestation* that any coding agent can publish through the existing registry. The hosted aggregator that consumes these is **Spec B** and gets its own brainstorm → spec → plan cycle.

## Problem

The repo already ships nearly all the producer machinery — `distill`, `scanWorkflow`, PII `scrub`/secret `redact`, the Gem archive format (`writeGemArchive`/`gem.lock`), the GitHub-backed `registry`, and `search`. What's missing is a **canonical, signed, privacy-safe record of what a shared Gem actually used** — which harness, which model(s), which skills, which MCP servers/tools — expressed with *stable global identities* so the same ingredient used by different people collapses to one graph node.

Without that record there is no usage graph (defeats #1), and without grounding + signing the record is trivially faked (defeats #2).

## Key decisions (resolved during brainstorming)

1. **Graph shape: layered, usage-layer first.** A *usage graph* (ingredient nodes: harness, model, skill, MCP, tool; edges: "this Gem used that ingredient") sits under a future *dependency/fork graph* (Gem→Gem edges) that PageRank will run on. Spec A builds the usage layer only; fork edges + PageRank are a later spec.
2. **Attestation location: inside the Gem archive (Decision 1 = A).** A signed `attestation.json` is written into the archive alongside `gem.json`/`gem.lock`, anchored to the Gem digest. Every usage claim is tied to a concrete shared Gem. A standalone "usage report with no Gem" is explicitly **deferred** (revisit when acquisition/volume becomes the priority).
3. **Trust anchor: local keypair + account-attestation.** An ed25519 keypair signs the attestation (integrity + cross-submission continuity). The publishing identity binds it to a real account via **OAuth (Sign in with Vercel / GitHub OAuth) at the hosted ingest endpoint** (per the 2026-06-27 amendment; the earlier "commit author is the binding" shortcut is superseded). Harness-signed run receipts are a future "verified" tier. PageRank handles ranking-level sybil resistance later.
4. **Anti-fabrication via grounding.** The usage profile is *extracted from real transcripts by the existing scan*, not self-declared. The envelope carries `evidence.signalDigest` (a hash of the redacted `WorkflowSignal` it derived from) so the Spec-B aggregator can later re-verify that declared counts never exceed what the signal supports.
5. **Ingredient identity: canonical fingerprint with graceful fallback.** Cross-user node-merging is the whole point of the moat, so ingredients get stable global ids (see §Ingredient canonicalization). `redact.ts` scrubs command/args before any fingerprint is computed.
6. **MCP/skill division of labor.** The MCP server is a deterministic, side-effect-light **data layer**; the skill is the **procedure** that drives the *host* coding agent to make judgment calls. The generative judgment that today runs in a nested ACP agent moves up to the host agent — less plumbing, cleaner MCP surface.

## Architecture

```
host coding agent (Claude Code / Codex / …)   ← does the judgment
        │ reads
   agentgem-share SKILL                         ← the procedure + privacy-review gate
        │ calls tools
   agentgem-distill MCP server                  ← deterministic data layer (no nested agent)
     scan_workflow · inspect_ingredients · build_attestation · sign_and_publish
        │ reuses (unchanged)
   scanWorkflow · scrub · redact · buildGem · writeGemArchive · publishGem
        │ publish
   GitHub-backed registry  ──(later)──►  Spec B aggregator / usage graph / leaderboard
```

Everything below the MCP server is reused as-is. Net-new code: the four tools, the attestation builder + canonicalization, ed25519 sign/verify, the skill, and a small extension to `scanWorkflow` to extract model ids.

## The attestation envelope (the asset)

A new signed `attestation.json` in the Gem archive, anchored to the Gem's digest:

```jsonc
{
  "formatVersion": 1,
  "gem": { "name": "...", "version": "...", "digest": "sha256:…" },   // binds to gem.lock
  "producer": {
    "publicKey": "ed25519:…",                          // local keypair (continuity)
    "account": { "provider": "github", "login": "…" }  // from the OAuth session at the hosted ingest endpoint
  },
  "source": {
    "harness": { "id": "claude-code", "version": "…" }, // canonical
    "models":  ["claude-opus-4-8", "…"],                // canonical ids seen in transcripts
    "scan":    { "sessions": 9, "spanDays": 21, "firstMs": 0, "lastMs": 0 }  // grounding
  },
  "ingredients": {
    "skills": [ { "id": "@scope/x", "idKind": "registry", "invocations": 12, "sessions": 4 } ],
    "mcps":   [ { "id": "npx:@modelcontextprotocol/server-github", "idKind": "package",
                  "transport": "stdio", "sessions": 6,
                  "tools": [ { "name": "create_issue", "invocations": 7 } ] } ]
  },
  "evidence": {
    "signalDigest": "sha256:…",                // always present: tamper-evident commitment
    "signal": { /* full redacted WorkflowSignal — OPTIONAL, opt-in → "verified" tier */ }
  },
  "signedAt": 0,
  "signature": "ed25519:…"                      // over the canonical doc minus this field
}
```

- `account` reuses the existing GitHub publish identity — no new auth in Spec A.
- `evidence.signalDigest` is the anti-fabrication anchor: Spec B re-verifies declared counts ≤ what the signal supports.
- `gem.lock.signature` (currently always `null`) gets populated by the same signing step.

## Ingredient canonicalization

Each ingredient yields a stable `id` plus an `idKind` recording identity confidence (so Spec B can weight noisy ids):

| Ingredient | Canonical `id` | `idKind` (best → worst) |
|---|---|---|
| harness | `claude-code`, `codex` (from `WorkflowSignal.flavor`) | `known` → `unknown` |
| model | raw model id, lowercased (`claude-opus-4-8`) | `known` → `unknown` |
| skill | published `@scope/name` → sha256 of `SKILL.md` → normalized name | `registry` → `contentHash` → `name` |
| mcp server | stdio: package/bin from scrubbed argv (`npx:@scope/pkg`); http/sse: URL host+path | `package` → `url` → `name` |
| mcp tool | `<server-id>/<tool>` from `mcp__server__tool` tool_use blocks | inherits server kind |

`redact.ts` runs on command/args **before** fingerprinting. A lower-confidence `idKind` means a more "local/unmergeable" node — that is itself a signal, not a failure.

## MCP tool contracts

All read-only except `sign_and_publish`:

- **`scan_workflow({ cwd?, scope? })`** → `{ signal: RedactedWorkflowSignal, signalDigest }`. Wraps `scanWorkflow`. Pure read.
- **`inspect_ingredients({ cwd? })`** → `{ harness, models[], skills[], mcps[] }` with canonical ids + `idKind`. Joins the scan against the introspected inventory. Pure read.
- **`build_attestation({ gemSelection, includeSignal? })`** → `{ attestation /* unsigned */, gemPreview, willPublish }`. Calls `buildGem` + `writeGemArchive`, computes the usage profile from the scan, returns the **unsigned** envelope plus a human-readable "what will leave your machine" preview. `includeSignal: true` embeds the full redacted `WorkflowSignal` in `evidence.signal` (opt-in "verified" tier; the preview must show it). No writes, no network.
- **`sign_and_publish({ attestation, ref })`** → `{ publishedRef, gemDigest, signature, ingestId }`. Signs with the local keypair (generating one at `~/.agentgem/identity.json` on first use), writes `attestation.json` into the archive, populates `gem.lock.signature`, then **(a)** publishes the archive to the GitHub registry via `publishGem` (distribution) and **(b)** POSTs the signed attestation to the hosted ingest endpoint over an OAuth session (the data-critical step; verified at the door). The only tool that touches the network. The OAuth flow runs on first publish and the token is cached locally.

The split guarantees the skill's privacy gate runs on the *final* bytes before anything is signed or published.

## The share skill (procedure)

`SKILL.md` driving the host agent:

1. `scan_workflow` → ground in real usage.
2. Surface candidate Gems/procedures; user picks what to share (judgment lives in the host agent).
3. `build_attestation` → **show the user the exact scrubbed envelope + archive preview** — a mandatory privacy gate (trust *toward the user*, distinct from anti-fraud *toward the network*).
4. On explicit confirmation only → `sign_and_publish`.

## Privacy

Reuses `scrub.ts` (transcript steps) + `redact.ts` (config secrets). The envelope carries only canonical ids, counts, and coarse metrics — no prompts, file contents, outputs, or paths. The step-3 gate is a hard stop. **When a producer opts into `includeSignal`, the embedded `evidence.signal` carries more detail than the summary metrics, so `scrub` must be airtight on it and the privacy gate must render it in full before signing.**

## Trust posture (Spec A scope)

- **Grounded** — profile derived from a real scan, not typed in.
- **Integrity** — ed25519 over the canonical doc; tamper breaks verification.
- **Continuity** — a stable producer key ties submissions together.
- **Sybil cost** — account = the publish (GitHub) identity.
- **Deferred to B/later** — PageRank ranking, fork/dependency edges, content-hash edge inference, statistical anomaly detection, harness-signed run receipts.

## Testing

vitest on compiled `dist` (per existing setup):

- Canonicalization unit tests — name variants collapse to one id; `idKind` downgrades correctly.
- Attestation build from a fixture `WorkflowSignal` — deterministic, stable digest.
- Sign/verify round-trip; tamper → verify fails.
- **Privacy assertion test** — feed a transcript laced with secrets/PII; assert none appear anywhere in the attestation.
- Integration — `build_attestation` → `sign_and_publish` → read back via `readGemArchive` + `verifyLock`.

## Out of scope (later specs)

- The hosted aggregator, DB, usage graph store, leaderboard, search ranking, reviews, data-provider API (**Spec B**).
- Fork/dependency edges + PageRank ranking, install-attested provenance receipts, content-hash edge inference (the dependency-graph spec).
- Standalone usage report with no Gem (revisit when acquisition becomes the priority).
- Harness-signed run receipts ("verified" tier).
