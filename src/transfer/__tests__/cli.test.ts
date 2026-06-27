// src/transfer/__tests__/cli.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryObjectStore } from "../objectStore.js";
import { runCli } from "../cli.js";

describe("runCli", () => {
  it("send writes a ticket to stdout; receive verifies and writes bytes", async () => {
    const store = new InMemoryObjectStore();
    const files = new Map<string, Buffer>();
    const out: string[] = [];
    const errs: string[] = [];
    const io = {
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, b: Buffer) => void files.set(p, b),
      log: (s: string) => out.push(s),
      err: (s: string) => errs.push(s),
    };
    // a real .gem to send
    const { exportGem } = await import("../../gem/share.js");
    const demo = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as const;
    files.set("in.gem", exportGem(demo as any, { version: "2.0.0" }).bytes);

    expect(await runCli(["send", "in.gem"], store, io)).toBe(0);
    const ticket = out[0];
    expect(ticket.startsWith("agentgem://gem/")).toBe(true);

    // the key fragment (after #) must not appear in any err line separately
    const fragment = ticket.includes("#") ? ticket.slice(ticket.indexOf("#") + 1) : "";
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ticket); // ticket logged exactly once via log
    for (const line of errs) {
      expect(line).not.toBe(fragment); // key not logged separately to err
    }

    expect(await runCli(["receive", ticket, "out.gem"], store, io)).toBe(0);
    expect(files.get("out.gem")).toEqual(files.get("in.gem"));
  });

  it("returns exit code 2 on bad usage", async () => {
    const store = new InMemoryObjectStore();
    const io = { readFile: async () => Buffer.alloc(0), writeFile: async () => {}, log: () => {}, err: () => {} };
    expect(await runCli(["bogus"], store, io)).toBe(2);
  });

  it("receive with malformed ticket returns exit code 1 and writes an error message", async () => {
    const store = new InMemoryObjectStore();
    const errs: string[] = [];
    const io = {
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      log: () => {},
      err: (s: string) => errs.push(s),
    };
    expect(await runCli(["receive", "not-a-ticket"], store, io)).toBe(1);
    expect(errs.length).toBeGreaterThan(0);
  });
});
