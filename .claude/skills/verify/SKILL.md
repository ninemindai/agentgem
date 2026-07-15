---
name: verify
description: Build, launch, and drive this repo's console app to verify a change end-to-end in a real browser.
---

# Verifying agentgem changes at the running surface

## Build + launch

```bash
pnpm build                       # tsc -b AND the console SPA bundle — both required
AGENTGEM_HOME=$(mktemp -d) PORT=<unused-port> node dist/index.js
```

- **Always restart the server after a rebuild** — it caches the console SPA HTML at boot, and
  built-in miniapp constants (e.g. `EMBER_HTML`) are module-level imports.
- **Pick a genuinely unused port** and confirm ownership: with concurrent agent sessions in
  sibling worktrees, another session's server may already hold your port and your `node` exits
  after printing its banner. Check `lsof -p $(lsof -tnP -iTCP:<port> -sTCP:LISTEN) | grep cwd`
  points at YOUR worktree.
- `AGENTGEM_HOME` isolates agentgem's own data; watched transcripts still come from the real
  `~/.claude`, so Watch/hygiene/Ember surfaces show real sessions.

## Drive

- Console pages are hash routes: `http://localhost:<port>/#/arcade`, `#/watch`, `#/play`, …
- Browser consent for Play capabilities is per-origin `localStorage`
  (`agentgem:play:consent:<gem>:<cap>`) — a reused port silently skips consent modals; clear
  those keys to test the consent path.
- Sealed miniapp iframes are null-origin: you cannot reach inside from the top document. To
  observe the broker wire, wrap `window.EventSource` in the top window (streams live there),
  or listen for `message` events (game→host half is visible on `window`).
- SSE surfaces are also curl-able directly, e.g.
  `curl -N "http://localhost:<port>/api/watch/hygiene?file=<transcript>"`.

## Gotchas

- This is the USER'S real Chrome. Use `new_tab`, never `goto_url` on their active tab, and
  expect the active tab to change under you mid-session — re-verify what tab you're driving
  before every coordinate click.
- Miniapp canvas games take seconds to first-paint; wait and re-screenshot before diagnosing.
