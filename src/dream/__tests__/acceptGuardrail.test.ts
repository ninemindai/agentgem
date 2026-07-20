// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
// src/dream/__tests__/acceptGuardrail.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enqueueNew } from "@agentgem/app/dream/store";
import { DreamController } from "@agentgem/app/dream.controller";
import type { DreamQueueEntry } from "@agentgem/app/dream/types";

const prov = { occurrences: [{ sessionId: "s1", transcript: "t.jsonl", messageIndices: [1], atMs: 5 }] };

function guardrailEntry(root: string): DreamQueueEntry {
  return {
    key: `guardrail:${root}:repeated-tool-error:abc`, kind: "guardrail", root,
    name: "repeated-tool-error-abc", summary: "Bash errored 2x", confidence: "medium", phase: "LEARN",
    status: "queued", firstSeenMs: 0,
    draft: { detectorId: "repeated-tool-error", tool: "Bash", detail: "Bash errored 2x", confidence: "medium",
      occurrences: 2, provenance: prov } as DreamQueueEntry["draft"],
  };
}

// Mirror the existing dream.controller test's construction seam: real home is
// injected AFTER construction (the controller reads `private base = agentgemHome()`).
function ctl(base: string): DreamController {
  const c = new DreamController();
  (c as unknown as { base: string }).base = base;
  return c;
}

describe("accept guardrail", () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "acc-"));
    writeFileSync(join(base, "CLAUDE.md"), "base\n", "utf8");
  });

  it("previews the seed and applies the human-edited directive to CLAUDE.md, hash-guarded", async () => {
    const key = `guardrail:${base}:repeated-tool-error:abc`;
    enqueueNew([guardrailEntry(base)], base);
    const c = ctl(base);

    const pre = await c.previewGuardrail({ body: { key } });
    expect(pre.seed).toBe("- Bash errored 2x");     // seed is derived from draft.detail
    expect(pre.target).toBe("claude");
    expect(pre.ambiguous).toBe(false);
    expect(pre.malformed).toBe(false);
    expect(pre.next).toContain("agentgem:learnings"); // managed block would be inserted

    // Human authors the real directive; only the edited text is applied.
    const res = await c.accept({ body: { key, expectHash: pre.hash, target: "claude", directive: "- Fix the Bash prereq." } });
    expect(res.ok).toBe(true);
    const written = readFileSync(join(base, "CLAUDE.md"), "utf8");
    expect(written).toContain("- Fix the Bash prereq."); // edited directive, not the seed
    expect(written).not.toContain("- Bash errored 2x");  // seed did NOT leak through
    expect(written).toContain("base");                    // user content preserved
    expect((await c.queue()).items.length).toBe(0);       // accepted → off the queue
  });

  it("rejects a stale hash and leaves CLAUDE.md + the queue untouched", async () => {
    const key = `guardrail:${base}:repeated-tool-error:abc`;
    enqueueNew([guardrailEntry(base)], base);
    const c = ctl(base);
    await c.previewGuardrail({ body: { key } });

    await expect(
      c.accept({ body: { key, expectHash: "deadbeef", target: "claude", directive: "- nope." } }),
    ).rejects.toThrow(/changed since preview/i);

    expect(readFileSync(join(base, "CLAUDE.md"), "utf8")).not.toContain("- nope.");
    expect((await c.queue()).items[0].status).toBe("queued"); // never accepted
  });

  it("flags a malformed managed block on preview and refuses to apply", async () => {
    // OPEN marker with no CLOSE → the writer can't know where the block ends.
    writeFileSync(join(base, "CLAUDE.md"), "base\n<!-- agentgem:learnings -->\nhalf a block\n", "utf8");
    const key = `guardrail:${base}:repeated-tool-error:abc`;
    enqueueNew([guardrailEntry(base)], base);
    const c = ctl(base);

    const pre = await c.previewGuardrail({ body: { key } });
    expect(pre.malformed).toBe(true);
    expect(pre.next).toBe(pre.current); // no diff offered

    await expect(
      c.accept({ body: { key, expectHash: pre.hash, target: "claude", directive: "- x." } }),
    ).rejects.toThrow(/malformed/i);
    expect((await c.queue()).items[0].status).toBe("queued");
  });

  it("previews and applies against AGENTS.md — not CLAUDE.md — when both files exist and target=agents is requested", async () => {
    const agentsContent = "agents base\n";
    writeFileSync(join(base, "AGENTS.md"), agentsContent, "utf8"); // CLAUDE.md already exists from beforeEach → ambiguous
    const key = `guardrail:${base}:repeated-tool-error:abc`;
    enqueueNew([guardrailEntry(base)], base);
    const c = ctl(base);

    const pre = await c.previewGuardrail({ body: { key, target: "agents" } });
    expect(pre.target).toBe("agents");
    expect(pre.ambiguous).toBe(true);
    expect(pre.hash).toBe(createHash("sha256").update(agentsContent).digest("hex")); // AGENTS.md's hash, not CLAUDE.md's
    expect(pre.hash).not.toBe(createHash("sha256").update(readFileSync(join(base, "CLAUDE.md"), "utf8")).digest("hex"));

    const res = await c.accept({ body: { key, expectHash: pre.hash, target: "agents", directive: "- rule" } });
    expect(res.ok).toBe(true);
    expect(readFileSync(join(base, "AGENTS.md"), "utf8")).toContain("- rule");
    expect(readFileSync(join(base, "CLAUDE.md"), "utf8")).toBe("base\n"); // untouched
  });
});
