# CLAUDE.md

## Concurrent sessions

Use **git worktrees** to isolate concurrent sessions. When more than one agent or
session may be working in this repo at the same time, create a dedicated worktree
per session instead of sharing the main checkout. **Always branch off the freshly
fetched `origin/main`, never the local `main`** (see below):

```bash
git fetch origin
git worktree add ../agentgem-worktrees/<task> -b <task> origin/main
```

**Always nest worktrees under the sibling `agentgem-worktrees/` directory** — one
subdirectory per task — rather than scattering flat `agentgem-<task>` siblings next
to the repo. Keeping them in one container makes the checkout list legible and the
cleanup sweep easy. This keeps each session's branch, working tree, and build
artifacts (`dist/`, `tsconfig.tsbuildinfo`) separate, avoiding cross-session
interference. Remove the worktree when the work is merged or abandoned:

```bash
git worktree remove ../agentgem-worktrees/<task>
```

## Integration: keep local `main` a clean mirror

Worktrees isolate each session's working tree — that part is automatic. The thing
that actually bites is a **divergent local `main`**: with many concurrent
worktrees, `main` drifts if it's committed to directly or left stale, and ends up
both ahead of and behind `origin/main` (not fast-forwardable) — and it's often
**checked out in another worktree** (e.g. `../agentgem-worktrees/run`) you must not disturb.
Keep `main` clean and **a PR is the default integration path**; a direct local
merge is the exception. The PR route runs CI (`test (24)`) before
anything lands, never touches the `main` checkout, and serializes safely when
several sessions integrate at once — worth the round-trip as the default.

- **Never commit directly to `main`.** Treat it as a read-only mirror of
  `origin/main` — only ever fast-forward it
  (`git fetch && git checkout main && git merge --ff-only origin/main`). Do all
  work on feature branches. Direct commits are what make `main` diverge "ahead"
  and stop fast-forwarding.
- **Branch off freshly-fetched `origin/main`**, not local `main`, so your diff is
  against the real trunk.
- **Finish with a PR (default):** push the branch and open a PR; let CI gate it and
  merge once green (`gh run watch <run-id> --exit-status` then
  `gh pr merge --rebase --delete-branch`). See **PR lifecycle** below for the
  gating facts and the verify-each-commit-landed check — the PR path is where the
  dropped-commit trap lives, so follow it.
- **Local merge (the exception)** — only for a trivial change you deliberately want
  to skip CI/review on, *and* when `main` isn't checked out in another worktree: in
  the one checkout that holds `main`, `git fetch` then **sync down**
  (`git merge --ff-only origin/main` — local only, *no push*; it just advances local
  `main` up to the remote), `git merge <branch>` (new commits, now ahead of the
  remote), run tests, then **push up** (`git push` — the step that publishes to
  `origin/main`). The ff-only sync and the push move in opposite directions; only
  the push leaves your machine.
- **Before finishing, confirm** your branch is ahead of `origin/main` *only* (not
  built on a stale/divergent local `main`).

## PR lifecycle: one PR = one settled scope

When a PR is the integration path, the thing that bites is **appending commits to
a PR across many turns while it may already be merged**. A merge takes only the
commits the PR held *at merge time* and closes it; later pushes to that branch land
on the branch with no open PR to carry them to `main` — they're silently dropped
from the trunk. This has bitten multi-commit PRs here twice (only the first commit
landed both times).

- **Don't grow one PR incrementally across turns.** When a new scope appears
  ("now also make it X"), open a **new** PR off freshly-fetched `origin/main`
  rather than piling more commits onto a branch whose PR you've already handed over
  for review/merge — the reviewer may merge it the moment it looks done.
- **`gh pr edit` succeeding is NOT proof the PR is open** — you can edit a *merged*
  PR's body. Check `gh pr view <n> --json state` (want `OPEN`) before pushing
  follow-on commits to its branch.
- **After any merge, verify each commit's content is actually on `origin/main`** —
  `git fetch` then grep `origin/main:<file>` for a marker from *every* commit, not
  just the first. Don't trust the "merged" notification. If commits were dropped,
  they're safe on the local branch: `git rebase origin/main` (already-merged commits
  auto-skip) → fresh branch → new PR.
- **Merge gating:** `main` requires the single CI check `test (24)`; no required
  reviews. `test (26)` runs only on release tags (`v*`, `desktop-v*`), so it is
  **not** a PR gate. "Require branches up to date before merging" (`strict`) is
  off, so a green PR needn't be rebased onto the latest `main` before merging.
  Repo auto-merge is disabled, so `gh pr merge --rebase` only works once CI is
  green — `gh run watch <run-id> --exit-status` first. Do **not** `--admin`-bypass
  branch protection without explicit human say-so.
- **`gh pr merge --delete-branch` will error** on the local branch-delete step
  because `main` is checked out in another worktree — but the **remote merge still
  succeeds**. Verify the merge landed; don't trust the error.
