// packages/console/pwa-manifest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest } from "./pwa-manifest.mjs";

test("manifest has standalone display, both name fields, and 3 icons incl. maskable", () => {
  const m = buildManifest();
  assert.equal(m.display, "standalone");
  assert.equal(m.name, "AgentGem Console");
  assert.equal(m.short_name, "AgentGem");
  assert.equal(m.start_url, "/");
  assert.equal(m.theme_color, "#f1eadb");
  const sizes = m.icons.map(i => `${i.sizes}/${i.purpose ?? "any"}`);
  assert.ok(sizes.includes("192x192/any"));
  assert.ok(sizes.includes("512x512/any"));
  assert.ok(sizes.includes("512x512/maskable"));
  assert.ok(m.icons.every(i => i.src.startsWith("data:image/png;base64,")));
});
