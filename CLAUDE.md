# CLAUDE.md

## Concurrent sessions

Use **git worktrees** to isolate concurrent sessions. When more than one agent or
session may be working in this repo at the same time, create a dedicated worktree
per session instead of sharing the main checkout. **Always branch off the freshly
fetched `origin/main`, never the local `main`** (see below):

```bash
git fetch origin
git worktree add ../agentgem-<task> -b <task> origin/main
```

This keeps each session's branch, working tree, and build artifacts (`dist/`,
`tsconfig.tsbuildinfo`) separate, avoiding cross-session interference. Remove the
worktree when the work is merged or abandoned:

```bash
git worktree remove ../agentgem-<task>
```

## Integration: PR against `origin/main`, never merge to local `main`

`origin/main` is the shared trunk — every change lands there via a Pull Request
(this is how the merged PRs in history landed). The **local `main` branch is not
the trunk**: with many concurrent worktrees it drifts (commits made in one
worktree, partial experiments) and routinely diverges from `origin/main` (both
ahead and behind), so it is *not* fast-forwardable and is often **checked out in
another worktree** (e.g. `../agentgem-run`) that you must not disturb.

Therefore:

- **Branch from `origin/main`** (fetch first), not `main` — your work starts from
  the real trunk, so the eventual diff and PR are clean.
- **Finish by pushing the branch and opening a PR against `origin/main`.** Do
  **not** `git checkout main && git merge <branch>`: it writes into another
  session's working tree and merges onto a divergent main no one shares.
- **Don't try to "merge to local main locally"** as a shortcut. If you genuinely
  need a local trunk, fast-forward a *fresh* checkout to `origin/main` first — but
  the default is always the PR.

Before starting, sanity-check you're current: `git fetch origin` then branch off
`origin/main`. Before finishing, confirm the branch is ahead of `origin/main`
only (not based on a stale local main).
