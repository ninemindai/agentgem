// src/play/__tests__/scaffolds.skillTuner.test.ts
import { describe, it, expect } from "vitest";
import { scaffoldFor, staticGate, assertPortable, deriveNeeds } from "@agentgem/play";

describe("skill-tuner scaffold", () => {
  const html = () => scaffoldFor("skill-tuner");

  it("passes the static gate untouched", () => {
    expect(staticGate(html())).toEqual({ ok: true, failures: [] });
  });

  it("derives copy-command from a literal method call", () => {
    // Save derives needs from source text; an aliased reference would be pruned and then fail at play time.
    expect(deriveNeeds(html())).toContain("copy-command");
  });

  it("needs no baked timeline: copy-command is an enhancement, not content", () => {
    expect(assertPortable(html(), ["copy-command"])).toEqual({ ok: true, failures: [] });
  });

  it("renders the skill readout before any host call, so it is useful with no clipboard", () => {
    expect(html()).toContain('getElementById("game-data")');
    expect(html()).toContain("render()");
  });

  it("gates the copy on agentgemApp.ready, not on a rejection", () => {
    // With no host the shim's handshake gives up ONCE at ~4.8s and rejects only the calls pending at
    // that instant; a user-initiated copyCommand clicked later queues with no interval left to reject
    // it, so it hangs forever and a .catch(fallback) never fires. Gate on `ready` (false-forever with
    // no host) so the fallback runs immediately instead.
    expect(html()).toContain("agentgemApp.ready");
  });
});
