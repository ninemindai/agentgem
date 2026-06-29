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

## Integration: keep local `main` a clean mirror

Worktrees isolate each session's working tree — that part is automatic. The thing
that actually bites is a **divergent local `main`**: with many concurrent
worktrees, `main` drifts if it's committed to directly or left stale, and ends up
both ahead of and behind `origin/main` (not fast-forwardable) — and it's often
**checked out in another worktree** (e.g. `../agentgem-run`) you must not disturb.
Keep `main` clean and **local merge is the default integration path**; a PR is the
exception.

- **Never commit directly to `main`.** Treat it as a read-only mirror of
  `origin/main` — only ever fast-forward it
  (`git fetch && git checkout main && git merge --ff-only origin/main`). Do all
  work on feature branches. Direct commits are what make `main` diverge "ahead"
  and stop fast-forwarding.
- **Branch off freshly-fetched `origin/main`**, not local `main`, so your diff is
  against the real trunk.
- **Finish with a local merge (default):** in the one checkout that holds `main`,
  sync it (`git merge --ff-only origin/main`), `git merge <branch>`, run tests,
  then `git push`. Don't check `main` out where it's already checked out in
  another worktree.
- **Reach for a PR only when** integrations may overlap (two sessions merging at
  once — git won't let `main` be checked out in two worktrees, so they'd serialize
  anyway and the remote is the safer rendezvous) or when you want CI/review before
  it lands.
- **Before finishing, confirm** your branch is ahead of `origin/main` *only* (not
  built on a stale/divergent local `main`).
