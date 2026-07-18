import { describe, it, expect } from "vitest";
import { dispatchExtra, type ExtraCommand } from "../extraCommands.js";

describe("dispatchExtra", () => {
  it("returns null when the first arg is not a registered extra command", async () => {
    expect(await dispatchExtra(["get", "foo"], {})).toBeNull();
    expect(await dispatchExtra([], {})).toBeNull();
  });

  it("invokes a registered command with the remaining argv and returns its code", async () => {
    let seen: string[] | undefined;
    const table: Record<string, ExtraCommand> = {
      "index-sources": async (argv) => { seen = argv; return 3; },
    };
    const code = await dispatchExtra(["index-sources", "--flag"], table);
    expect(seen).toEqual(["--flag"]);
    expect(code).toBe(3);
  });

  it("maps a void return to exit code 0", async () => {
    const table: Record<string, ExtraCommand> = { doit: async () => {} };
    expect(await dispatchExtra(["doit"], table)).toBe(0);
  });

  it("defaults to an empty table (no extra commands in OSS)", async () => {
    expect(await dispatchExtra(["anything"])).toBeNull();
  });

  it("falls through (null) for prototype-chain keys, not just own keys", async () => {
    expect(await dispatchExtra(["constructor"])).toBeNull();
    expect(await dispatchExtra(["toString"])).toBeNull();
    expect(await dispatchExtra(["__proto__"])).toBeNull();
  });
});
