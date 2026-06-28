import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("build-client", () => {
  beforeAll(() => { execFileSync("node", ["build-client.mjs"], { cwd: pkg }); }, 60000);

  it("emits a self-contained index.html with the mount node and bundle", () => {
    const html = readFileSync(join(pkg, "dist", "index.html"), "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<script type="module">');
    expect(html.length).toBeGreaterThan(1000);
  });
});
