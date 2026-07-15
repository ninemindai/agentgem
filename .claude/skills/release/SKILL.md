---
name: release
description: Use when cutting an AgentGem release — core npm (vX.Y.Z) and/or desktop (desktop-vX.Y.Z) — or when asked to bump the version, write release notes, or tag a release.
---

# Cutting an AgentGem release

Core (`@ninemind/agentgem`) and the desktop app **share one version number** but are
tagged separately: `vX.Y.Z` (core) and `desktop-vX.Y.Z` (desktop). A normal release
ships both tags on the same commit.

## 1. Release worktree + branch

```bash
git fetch origin
git worktree add ../agentgem-worktrees/release-X.Y.Z -b release/X.Y.Z origin/main
cd ../agentgem-worktrees/release-X.Y.Z && pnpm install --frozen-lockfile
```

## 2. One release commit

Three files, one commit, message `release: vX.Y.Z — core + desktop`:

- `package.json` + `desktop/package.json` — bump `"version"` in both.
- `CHANGELOG.md` — Keep-a-Changelog style, **two sections** inserted above the previous
  release: `## [X.Y.Z] — \`@ninemind/agentgem\` (npm core) — YYYY-MM-DD` (intro paragraph
  naming the release's themes + commit count from
  `git log --oneline vPREV..origin/main | wc -l`, then Added/Changed/Fixed) and
  `## [desktop-vX.Y.Z] — desktop app — YYYY-MM-DD` (desktop-specific changes, then a
  one-liner noting it embeds everything in core X.Y.Z).

## 3. PR → merge

Push, open a PR, wait for the `test (24)` gate, then rebase-merge
(`gh run watch <run-id> --exit-status`, `gh pr merge --rebase --delete-branch`).
`--delete-branch` errors on the local delete (main is checked out in another worktree)
— **the remote merge still succeeds**; verify with `git fetch` + check `origin/main`.

## 4. Tag the *main* commit, then push tags

A rebase merge mints a **new SHA** — tagging the branch commit strands the tag off-main
(this happened to v0.5.0/v0.6.0's branches; the tags were correctly placed on main).

```bash
git fetch origin
SHA=$(git log origin/main --format=%H --grep "release: vX.Y.Z" -1)
git tag -a vX.Y.Z         -m "vX.Y.Z — core + desktop"         "$SHA"
git tag -a desktop-vX.Y.Z -m "desktop-vX.Y.Z — core + desktop" "$SHA"
git push origin vX.Y.Z desktop-vX.Y.Z
```

## 5. What the tags trigger — and what stays manual

| Step | Trigger |
|---|---|
| Node 26 CI matrix | automatic on `v*` / `desktop-v*` push (`ci.yml`) |
| Desktop build + GitHub release (`latest*.yml` for auto-update) | automatic on `desktop-v*` (`desktop-release.yml`) |
| **npm publish** | **manual**: `npm publish` from the tagged checkout — `prepublishOnly` runs clean + build + bundle-bins |
| Website desktop-download link | manual follow-up PR pointing at `desktop-vX.Y.Z` |

## Gotchas

- Tag identity must be Raymond Feng `<raymond@ninemind.ai>`.
- Don't tag before the PR merges — you'd tag a SHA that never lands on main.
- Watch both tag-triggered workflows to green before calling the release done.
