// src/gem/__tests__/scrub.test.ts
import { describe, it, expect } from "vitest";
import { scrubStep, scrubProse, sanitizeShareText } from "@agentgem/insight";

describe("scrubStep — Bash", () => {
  it("derives a verb from argv0 + subcommand and keeps the command", () => {
    const r = scrubStep("Bash", { command: "git commit -m fix" });
    expect(r.verb).toBe("Bash:git commit");
    expect(r.arg).toContain("git commit");
  });

  it("coarsens the verb — no subcommand for path/filename/quoted args", () => {
    expect(scrubStep("Bash", { command: "cd /Users/me/proj" }).verb).toBe("Bash:cd");
    expect(scrubStep("Bash", { command: "cat package.json" }).verb).toBe("Bash:cat");
    expect(scrubStep("Bash", { command: 'echo "==="' }).verb).toBe("Bash:echo");
    expect(scrubStep("Bash", { command: "git commit -m x" }).verb).toBe("Bash:git commit");
    expect(scrubStep("Bash", { command: "npm run build" }).verb).toBe("Bash:npm run");
  });
  it("basenames an absolute argv0", () => {
    expect(scrubStep("Bash", { command: "/usr/local/bin/npx vitest" }).verb).toBe("Bash:npx vitest");
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

describe("sanitizeShareText — share-time description cleanup", () => {
  it("strips URLs", () => {
    const r = sanitizeShareText("see https://internal.example.com/path for details");
    expect(r).not.toContain("http");
    expect(r).toContain("see");
    expect(r).toContain("for details");
  });

  it("strips absolute-ish file paths", () => {
    const r = sanitizeShareText("generated from /Users/alice/projects/agentgem/src/foo.ts");
    expect(r).not.toContain("/Users/alice");
    expect(r).toContain("generated from");
  });

  it("collapses extra whitespace after stripping", () => {
    const r = sanitizeShareText("a  https://x.com/y   b");
    expect(r).not.toMatch(/\s{2,}/);
    expect(r).toBe("a b");
  });

  it("caps at max length with ellipsis", () => {
    const r = sanitizeShareText("a".repeat(200), 160);
    expect(r.length).toBeLessThanOrEqual(160);
    expect(r.endsWith("…")).toBe(true);
  });

  it("leaves ordinary text intact", () => {
    const r = sanitizeShareText("Edit a file then run git commit.");
    expect(r).toBe("Edit a file then run git commit.");
  });
});

describe("scrubProse — mission-hint text", () => {
  it("redacts secret tokens, de-homes paths, and truncates", () => {
    const home = process.env.HOME ?? "/Users/me";
    const r = scrubProse(`ship the feature using ghp_abcdefghijklmnopqrstuvwxyz0123456789 in ${home}/app`, 280);
    expect(r).toContain("ship the feature");
    expect(r).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(r).toContain("<redacted>");
    expect(r).not.toContain(home);
    expect(r).toContain("~/app");
  });

  it("truncates to maxLen with an ellipsis", () => {
    const r = scrubProse("ship the feature ".repeat(50), 50);
    expect(r.length).toBeLessThanOrEqual(51); // 50 + ellipsis char
    expect(r.endsWith("…")).toBe(true);
  });

  it("handles empty/whitespace input", () => {
    expect(scrubProse("", 280)).toBe("");
    expect(scrubProse("   ", 280)).toBe("");
  });
});
