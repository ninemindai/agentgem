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
    expect(html).toContain('<div id="root">');           // mount node, seeded with the boot splash
    expect(html).toContain('class="boot-splash"');         // static pre-React loading screen
    expect(html).toContain('<script type="module">');
    expect(html.length).toBeGreaterThan(1000);
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<meta name="theme-color" content="#f1eadb">');
    // and the manifest file itself is emitted
    const mani = JSON.parse(readFileSync(join(pkg, "dist", "manifest.webmanifest"), "utf8"));
    expect(mani.display).toBe("standalone");
    expect(mani.icons.length).toBe(3);
  });
});

describe("build-client extension seam", () => {
  // Guards the AGENTGEM_CONSOLE_EXTRA override path — the seam's whole purpose. Without
  // this, a refactor of build-client.mjs could silently break injection and the fast
  // unit test (which only checks the empty-stub composition) would still pass.
  it("swaps the extraPages stub for a downstream module when AGENTGEM_CONSOLE_EXTRA is set", () => {
    const fixture = join(pkg, "src", "__tests__", "fixtures", "extraPagesInjectionFixture.ts");
    execFileSync("node", ["build-client.mjs"], {
      cwd: pkg,
      env: { ...process.env, AGENTGEM_CONSOLE_EXTRA: fixture },
    });
    const html = readFileSync(join(pkg, "dist", "index.html"), "utf8");
    // The fixture's marker route reaches the bundle only if the plugin redirected
    // ./extraPages.js to it; the empty stub would never contain this string.
    expect(html).toContain("AGENTGEM_EXTRA_SEAM_SMOKE");
  }, 60000);
});
