// src/transfer/__tests__/cli.test.ts
import { describe, it, expect } from "vitest";
import { InMemoryObjectStore } from "../objectStore.js";
import { runCli } from "../cli.js";

describe("runCli", () => {
  it("send writes a ticket to stdout; receive verifies and writes bytes", async () => {
    const store = new InMemoryObjectStore();
    const files = new Map<string, Buffer>();
    const out: string[] = [];
    const io = {
      readFile: async (p: string) => files.get(p)!,
      writeFile: async (p: string, b: Buffer) => void files.set(p, b),
      log: (s: string) => out.push(s),
      err: (_s: string) => {},
    };
    // a real .gem to send
    const { exportGem } = await import("../../gem/share.js");
    const demo = { name: "x", createdFrom: "/tmp/.claude", checks: [], requiredSecrets: [],
      artifacts: [{ type: "skill", name: "s", source: "standalone", content: "# s\n" }] } as const;
    files.set("in.gem", exportGem(demo as any, { version: "2.0.0" }).bytes);

    expect(await runCli(["send", "in.gem"], store, io)).toBe(0);
    const ticket = out[0];
    expect(ticket.startsWith("agentgem://gem/")).toBe(true);

    expect(await runCli(["receive", ticket, "out.gem"], store, io)).toBe(0);
    expect(files.get("out.gem")).toEqual(files.get("in.gem"));
  });

  it("returns exit code 2 on bad usage", async () => {
    const store = new InMemoryObjectStore();
    const io = { readFile: async () => Buffer.alloc(0), writeFile: async () => {}, log: () => {}, err: () => {} };
    expect(await runCli(["bogus"], store, io)).toBe(2);
  });
});
