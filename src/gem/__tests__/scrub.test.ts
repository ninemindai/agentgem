// src/gem/__tests__/scrub.test.ts
import { describe, it, expect } from "vitest";
import { scrubStep } from "../scrub.js";

describe("scrubStep — Bash", () => {
  it("derives a verb from argv0 + subcommand and keeps the command", () => {
    const r = scrubStep("Bash", { command: "git commit -m fix" });
    expect(r.verb).toBe("Bash:git commit");
    expect(r.arg).toContain("git commit");
  });

  it("redacts a secret token in place but keeps the surrounding command", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const r = scrubStep("Bash", { command: `git push https://${secret}@github.com main` });
    expect(r.arg).not.toContain(secret);
    expect(r.arg).toContain("<redacted>");
    expect(r.arg).toContain("git push");
    expect(r.arg).toContain("main");
  });

  it("rewrites a $HOME-absolute path to ~", () => {
    const home = process.env.HOME ?? "/Users/me";
    const r = scrubStep("Bash", { command: `cat ${home}/Projects/app/secret.env` });
    expect(r.arg).not.toContain(home);
    expect(r.arg).toContain("~/Projects/app/secret.env");
  });
});

describe("scrubStep — field allowlist (default-deny)", () => {
  it("Edit keeps file_path but DROPS old_string/new_string content", () => {
    const r = scrubStep("Edit", {
      file_path: "/repo/src/app.ts",
      old_string: "const KEY = 'ghp_realsecretvaluehere'",
      new_string: "const KEY = process.env.KEY",
    });
    expect(r.verb).toBe("Edit");
    expect(r.arg).toContain("/repo/src/app.ts");
    expect(r.arg).not.toContain("ghp_realsecretvaluehere");
    expect(r.arg).not.toContain("process.env.KEY");
  });

  it("Write DROPS file contents, keeping only the path", () => {
    const r = scrubStep("Write", { file_path: "/repo/.env", content: "TOKEN=ghp_abc\nDB=postgres://u:p@h" });
    expect(r.verb).toBe("Write");
    expect(r.arg).toContain("/repo/.env");
    expect(r.arg).not.toContain("ghp_abc");
    expect(r.arg).not.toContain("postgres://");
  });

  it("Read keeps the path, verb is the tool name", () => {
    const r = scrubStep("Read", { file_path: "/repo/README.md" });
    expect(r.verb).toBe("Read");
    expect(r.arg).toContain("/repo/README.md");
  });

  it("Task keeps the description but DROPS the prompt (may carry pasted secrets)", () => {
    const r = scrubStep("Task", {
      subagent_type: "general-purpose",
      description: "find the bug",
      prompt: "here is my api key ghp_pastedsecretvalue and do X",
    });
    expect(r.verb).toBe("Task:general-purpose");
    expect(r.arg).toContain("find the bug");
    expect(r.arg).not.toContain("ghp_pastedsecretvalue");
  });

  it("an unknown tool yields verb=tool and DROPS the entire input", () => {
    const r = scrubStep("MysteryTool", { anything: "secret-data", more: 42 });
    expect(r.verb).toBe("MysteryTool");
    expect(r.arg).toBe("");
  });

  it("never throws on malformed input — degrades to verb-only", () => {
    expect(() => scrubStep("Bash", null)).not.toThrow();
    expect(() => scrubStep("Edit", undefined)).not.toThrow();
    expect(scrubStep("Bash", null)).toEqual({ verb: "Bash", arg: "" });
  });
});
