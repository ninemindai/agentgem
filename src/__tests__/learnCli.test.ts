// src/__tests__/learnCli.test.ts
import { describe, it, expect } from "vitest";
import { runLearnCommand } from "../learnCli.js";
import { InvalidInputError } from "@agentgem/model";
import type { LearnResult } from "../learnCore.js";

const result = (over: Partial<LearnResult> = {}): LearnResult =>
  ({
    session: "s1.jsonl", enqueued: 2,
    entries: [{ kind: "skill", name: "extract-api-client" }, { kind: "skill", name: "b" }],
    skills: 2, lessons: 0, guardrails: 0, degraded: false, ...over,
  });

describe("agentgem learn", () => {
  it("prints a summary and exits 0 on success", async () => {
    const lines: string[] = [];
    const code = await runLearnCommand(["/proj"], { learn: async () => result(), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes("s1.jsonl"))).toBe(true);
    expect(lines.some((l) => l.includes("2 queued"))).toBe(true);
    expect(lines.some((l) => l.includes(`+ skill "extract-api-client" queued`))).toBe(true);
  });

  it("nothing distilled exits 0 with an honest message", async () => {
    const lines: string[] = [];
    const code = await runLearnCommand(["/proj"], { learn: async () => result({ enqueued: 0, skills: 0 }), out: (l) => lines.push(l) });
    expect(code).toBe(0);
    expect(lines.some((l) => /nothing (new )?distilled/i.test(l))).toBe(true);
  });

  it("passes --session and --dir through, defaults root to cwd", async () => {
    let got: { root?: string; session?: string; dir?: string } = {};
    await runLearnCommand(["--session", "abc", "--dir", "/ch"], {
      learn: async (o) => { got = o; return result(); }, out: () => {},
    });
    expect(got.session).toBe("abc");
    expect(got.dir).toBe("/ch");
    expect(got.root).toBe(process.cwd());
  });

  it("maps InvalidInputError to exit 2 with the message", async () => {
    const errs: string[] = [];
    const code = await runLearnCommand(["/proj", "--session", "nope"], {
      learn: async () => { throw new InvalidInputError("no session 'nope'"); }, err: (l) => errs.push(l),
    });
    expect(code).toBe(2);
    expect(errs.some((l) => l.includes("no session"))).toBe(true);
  });
});
