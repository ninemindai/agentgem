# Security Policy

AgentGem's core promise is that **secrets never leave your device** — config is
redacted by value and by key name the moment it's read, before anything reaches a
REST response, an MCP result, the live preview, or a built Gem. We take reports
about that boundary seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Instead, report privately via GitHub's
[private vulnerability reporting](https://github.com/ninemindai/agentgem/security/advisories/new),
or email **security@ninemind.ai**.

Include, where you can:

- A description of the issue and its impact.
- Steps to reproduce, or a proof of concept.
- Affected version or commit.

We aim to acknowledge reports within **3 business days** and to provide a
remediation timeline after triage. We'll credit you in the advisory unless you
prefer to remain anonymous.

## Scope

Especially in scope:

- **Redaction bypass** — any path where a real secret value or sensitive key
  reaches a REST response, an MCP result, the live preview, or a built Gem.
- Secrets written to disk in a Gem archive, lock, or generated target.
- The local server binding beyond `127.0.0.1` or otherwise exposing config to
  the network.

Out of scope:

- Vulnerabilities in upstream dependencies — report those to their maintainers
  (we'll happily bump once they ship a fix).
- Findings that require an attacker to already have local filesystem access to
  `~/.claude` or the running machine.

## Handling secrets yourself

- Server credentials are stored outside the repo in `~/.agentgem/.env`
  (mode `0600`), written when you set a key through the AgentGem UI/API. Don't
  put real secrets in the repository.
- If you believe you've committed a secret, rotate it immediately — `.gitignore`
  does not remove anything already in git history.
