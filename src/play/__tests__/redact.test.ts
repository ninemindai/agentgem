// src/play/__tests__/redact.test.ts
import { describe, it, expect } from "vitest";
import { homedir } from "node:os";
import { redactForBake } from "@agentgem/play";

describe("redactForBake", () => {
  it("replaces the user's home-dir prefix with ~ in any string", () => {
    const home = homedir();
    const out = redactForBake({ timeline: [{ text: `edited ${home}/proj/app.ts` }] }) as { timeline: { text: string }[] };
    expect(out.timeline[0].text).toBe("edited ~/proj/app.ts");
    expect(out.timeline[0].text).not.toContain(home);
  });

  it("redacts secret-looking tokens", () => {
    const out = redactForBake({ meta: { note: "key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 here" } }) as { meta: { note: string } };
    expect(out.meta.note).toBe("key ‹redacted› here");
  });

  it("caps a long timeline to 500 entries", () => {
    const timeline = Array.from({ length: 620 }, (_, i) => ({ role: "user", text: `t${i}` }));
    const out = redactForBake({ timeline }) as { timeline: unknown[] };
    expect(out.timeline).toHaveLength(500);
  });

  it("reduces a project path + files to basenames (no local dir leak)", () => {
    const out = redactForBake({ path: "/Users/someone/work/secret-proj", flavor: "node", files: ["/Users/someone/work/secret-proj/package.json"] }) as { path: string; files: string[] };
    expect(out.path).toBe("secret-proj");
    expect(out.files).toEqual(["package.json"]);
  });

  it("passes non-string primitives through and does not mutate the input", () => {
    const input = { meta: { msgs: 3, ok: true }, timeline: [] };
    const out = redactForBake(input) as typeof input;
    expect(out).toEqual({ meta: { msgs: 3, ok: true }, timeline: [] });
    expect(out).not.toBe(input);
  });
});
