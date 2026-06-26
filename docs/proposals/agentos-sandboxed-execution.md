# Proposal: agentOS as a sandboxed execution backend for the Gem runner

- **Status:** Proposal (spiked, not adopted)
- **Date:** 2026-06-25
- **Area:** Gem runner (`src/gem/runGem.ts`, `src/gem/acpRun.ts`)
- **Depends on:** the shipped ACP Gem runner (run + verify + materialize)

## Summary

Add [agentOS](https://github.com/rivet-dev/agentos) (`@rivet-dev/agentos-core`) as an
*optional, additive* execution backend for the Gem runner, behind the existing
`RunConnectFn` seam. It runs an ACP coding agent inside an in-process VM with a
host-directory mount, so a Gem can be run with its filesystem blast radius contained
to the testbed. The local child-spawn backend stays the default; agentOS becomes the
backend for running **untrusted/registry Gems** and for **hosted/server-side
verification**.

## Motivation

The runner today spawns a local ACP adapter as a child process against a materialized
testbed on the host filesystem. Two things it deliberately does not solve:

1. **Sandboxing.** Running someone else's Gem (the marketplace case) means running an
   agent with tool access against your real filesystem. The testbed dir is a
   convention, not a boundary.
2. **Hosted execution.** The runner is local-only. There is no cheap way to run a Gem
   server-side — e.g. to compute a "verified" badge as a publish gate, or to let a
   user try a Gem without installing anything.

agentOS targets exactly these: an in-process VM (~6ms cold start, "up to 32x cheaper
than sandboxes"), deny-by-default permissions, a virtual filesystem with host-dir
mounting, and deployability to Vercel/Railway/Rivet Cloud. It speaks **ACP** — the
same protocol the runner is built on.

## Design

The runner already abstracts the agent connection behind `RunConnectFn`
(`open(cwd)` → session with `setMode`/`prompt(text, onDelta, onToolCall)` → `RunResult`).
The default `defaultRunConnectFn` spawns a child and stdio-bridges. agentOS slots in as
a second implementation of the same interface — no change to `runGemWithAgent`,
`verifyGemRun`, the controller, the UI, or the SSE stream.

```ts
// sketch — an agentOS-backed RunConnectFn
const agentOSConnectFn: RunConnectFn = async (descriptor) => {
  const vm = await AgentOs.create({
    software: [claude /* or codex via registry */],
    // open(cwd) mounts the materialized testbed at that path:
    // mounts: [{ path: cwd, plugin: createHostDirBackend({ hostPath: cwd, readOnly: false }) }],
    permissions: { /* scoped: substrate reads + workspace writes only */ },
  });
  // createSession(agent, { cwd }) → onSessionEvent(id, e => applyUpdate(acc, e.params.update, handlers))
  // prompt(id, task) → return the accumulated { text, toolCalls }
};
```

The mapping is close to 1:1 with what we built: `AgentOs.create({mounts, permissions})`
+ `createSession({cwd})` + `onSessionEvent` + `prompt` is our `connectAcpAdapter` →
`open(cwd)` → update-loop → `prompt`, just in-process instead of stdio. agentOS emits
`session/notify` updates with `sessionUpdate ∈ {agent_message_chunk, tool_call,
tool_result, …}`, which feed our existing `applyUpdate` reducer.

## Spike findings (live)

A throwaway spike ran a materialized stamp-Gem testbed through a real agentOS VM
(now removed; nothing landed in the codebase).

- **Host-directory mount — works.** A guest process read the materialized
  `.claude/skills/.../SKILL.md` through the mount and wrote a file that synced back to
  the host directory in real time.
- **Sandbox — real, but the useful policy needs care.** Enforcement is genuine and
  kernel-level: a blanket `fs:{default:"deny"}` blocked the VM's own `/bin` sync at boot
  (`read '/bin': blocked by fs.read policy`) and the sidecar failed to start. The
  containment that actually matters comes from the **VM + mount model itself** — a guest
  can only reach host paths you explicitly mount; writes anywhere else land in the
  ephemeral VM filesystem and never touch the host. Fine-grained intra-VM write rules
  exist too, but a naive `deny write /**` killed the guest's own Node runtime before it
  could run. A workable scoped-write policy (allow system reads + temp + workspace
  writes, deny the rest) is achievable but was not nailed in the spike.
- **Tool-call events — confirmed from source, not yet live.** `onSessionEvent` yields
  the `sessionUpdate` discriminators above, which map onto our reducer. The exact
  `tool_call` field names need one live agent run to confirm; that run was blocked by
  auth (see risks).
- **Custom/external ACP agent — supported.** Via `software: [{ type: "agent", … }]`,
  plus built-in `claude`/`opencode`/`pi` and Codex through the registry.

## Risks and caveats

- **Maturity (`@rivet-dev/agentos-core@0.2.0`).** Pre-1.0. The native sidecar *panics*
  on an over-restrictive fs policy instead of erroring gracefully.
- **`readOnly: true` host-dir mounts did not block guest writes** under `fs:"allow"` —
  rely on *not mounting* sensitive directories rather than on the flag, until this is
  understood.
- **Platform.** The native sidecar ships for darwin and linux only (no Windows).
- **Heavier dependency** than the current child-spawn (core + per-platform sidecar
  binary + native builds: isolated-vm, koffi, protobufjs).
- **Agent auth inside the sandbox.** The local runner reuses host credentials directly.
  An in-VM agent does not see host `~/.claude` / `~/.codex` — credentials must be
  provisioned (env or a mounted path). This is a real integration task, not a flag.

## Open questions (gating adoption)

1. A working **scoped-write fs policy** that boots the VM, lets the agent runtime
   function, and restricts writes to the mounted testbed. (The one genuinely unsolved
   item.)
2. The **live `tool_call` event shape** (field names) from a real agent run.
3. **Auth provisioning** for the in-VM agent.

## Recommendation

**Promising GO, not urgent.** The architecture fits cleanly as an additive backend, and
it is the right tool for the two gaps the runner punted. But it is gated on the three
open questions above and carries pre-1.0 + platform risk, so it should not be built
speculatively.

Adopt when there is a concrete trigger — most likely **enabling execution of untrusted
registry Gems** (run a stranger's Gem safely) or a **hosted verification** service.
Until then, keep the local child-spawn backend as the default and treat this as a
shovel-ready design.

## References

- agentOS: <https://github.com/rivet-dev/agentos> · `@rivet-dev/agentos-core`,
  `@agentos-software/{common,claude-code,opencode,pi}`
- Runner seam: `src/gem/acpRun.ts` (`RunConnectFn`, `applyUpdate`), `src/gem/runGem.ts`
  (`AGENT_ADAPTERS`, `resolveOrFetchAdapter`, `materializeAndRunGem`)
- Key agentOS API: `AgentOs.create({software, mounts, permissions})`,
  `createHostDirBackend({hostPath, readOnly})`, `createSession(agent, {cwd, env})`,
  `prompt(id, text)`, `onSessionEvent(id, cb)`, `vm.spawn`/`vm.waitProcess`
