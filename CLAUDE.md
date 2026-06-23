# CLAUDE.md

## Concurrent sessions

Use **git worktrees** to isolate concurrent sessions. When more than one agent or
session may be working in this repo at the same time, create a dedicated worktree
per session instead of sharing the main checkout:

```bash
git worktree add ../agentgem-<task> -b <task>
```

This keeps each session's branch, working tree, and build artifacts (`dist/`,
`tsconfig.tsbuildinfo`) separate, avoiding cross-session interference. Remove the
worktree when the work is merged or abandoned:

```bash
git worktree remove ../agentgem-<task>
```
