# Redaction

AgentGem's core safety rule: **secrets are redacted at capture.** The moment config is read,
secret values are stripped — before anything crosses a boundary. This page specifies the
rules and the data that carries them, as implemented in `src/gem/redact.ts`.

## The trust boundary

Redaction runs inside `introspect` (see the [pipeline](pipeline.md)), so the
`ConfigInventory` is already redacted before it reaches a REST response, an MCP result, the
live preview in the UI, or the built Gem. Serving config over HTTP and MCP doesn't weaken
this — it's the same redaction the original CLI enforced. Secrets stay on the machine; what
leaves is a config *shape* with `<redacted>` in place of every sensitive value.

`buildGem` adds a second line: any MCP/hook artifact that arrives **without** `secretRefs` is
re-redacted before it enters a Gem. A Gem therefore cannot be constructed from un-redacted
input, even if a caller skips introspection.

## What counts as a secret

`redactMcpConfig(config)` walks the config recursively and redacts a string value when any of
these hold:

1. **Key name matches** the secret pattern:

   ```
   /(api[_-]?key|token|secret|password|passwd|bearer|sk-|ghp_|gho_|xox[a-z]-|credential)/i
   ```

   This catches `api_key` / `apiKey` / `api-key`, `token`, `secret`, `password`, `bearer`,
   and provider prefixes like `sk-…`, `ghp_…`, `gho_…`, `xox…`.

2. **Value looks like a credential**:
   - a whitespace-free string that matches the pattern above or is a **high-entropy token**
     (32+ chars of `[A-Za-z0-9_-]`); or
   - a multi-word string in which **any** token is high-entropy (so a sentence that happens to
     contain a pasted key is still caught, while ordinary prose mentioning the word "token" is
     not).

3. **Context defaults**: values under an `env` or `headers` map are treated as secret by
   default, since those are where credentials normally live.

When a value is redacted it becomes the literal string `"<redacted>"`, and a reference is
recorded.

## What it records — `SecretRef`

```ts
interface SecretRef {
  name: string;     // leaf key, e.g. "OPENAI_API_KEY"
  location: string; // dotted path within the artifact config, e.g. "env.OPENAI_API_KEY"
}
```

`buildGem` aggregates these into the Gem's declared secret surface:

```ts
interface SecretRequirement {
  name: string;      // e.g. "OPENAI_API_KEY"
  artifact: string;  // owning artifact, e.g. mcp server "context7"
  location: string;  // re-injection path, e.g. "env.OPENAI_API_KEY"
}
```

So a Gem says *which* secrets it needs and *where* they plug in — never their values. Deploy
backends use this to wire up secret references (e.g. AgentCore maps each one to a token-vault
placeholder; managed publish collects them as `vaultSecrets`) without AgentGem ever handling
the real secret.

## Server credentials are different

The secrets above are **artifact** secrets and are always redacted. Separately, the AgentGem
*server* needs its own credentials to talk to deploy backends (e.g. `ANTHROPIC_API_KEY`,
`VERCEL_TOKEN`, `CLOUDFLARE_API_TOKEN`). Those are stored on the machine in
`~/.agentgem/.env` (mode `0600`) via `credentials.ts` and loaded at startup — they are
server config, never part of a Gem. See [Testbed & run](testbed-and-run.md).

## Transcript scrubbing — a second, stricter scrubber

`redactMcpConfig` is the right tool for **structured config** (it knows the keys). It is the
wrong tool for **free transcript text** — the builtin tool calls that
[Analyze distillation](analyze.md#distilled-skills) captures (bash command lines, file paths,
pasted prompts, file contents). Scrubbing arbitrary prose by blocklist both over-redacts
(one secret token nukes the whole command) and under-detects (short secrets, `user:pass@host`
URLs, PII in paths). So distillation uses a separate, **default-deny** scrubber,
`src/gem/scrub.ts` — distinct from `redact.ts`:

- **`scrubStep(tool, input)`** keeps only an *allowlisted structural slice* per builtin — a
  `Bash` command's coarse verb (`Bash:git commit`), an `Edit`/`Write` `file_path`, a
  `Read`/`Grep` path, a `Task` description — and **drops everything else** (file contents,
  `old_string`/`new_string`/`content`, agent prompts, unknown fields). The
  file-content/PII class is removed *by construction*, not by pattern match.
- What survives is then **path-redacted** (`$HOME`/`/Users/<name>/` → `~/`) and
  **token-scrubbed** at the *token* level. The token rule here is intentionally narrower than
  the config rule above: only **high-entropy** tokens or known **prefixes** (`ghp_`, `sk-`,
  `AKIA`, `glpat-`, …) — never bare keywords — so a filename like `secret.env` survives while
  a real `ghp_…` token is replaced in place.
- **`scrubProse`** applies the same token scrub + path redaction + a hard length cap to the
  one piece of genuine prose distillation keeps: the redacted mission hint (first task +
  outcome).

Residual risk (a short, keyword-less secret pasted mid-command) is accepted because distilled
output is a **draft behind a human-review gate** — it is never auto-installed.

## Related

- [The build pipeline](pipeline.md) — where redaction sits in the flow
- [Archive format](archive-format.md) — how `secretRefs` / `requiredSecrets` are stored
- [Concepts](concepts.md#the-redaction-trust-boundary) — the conceptual framing
