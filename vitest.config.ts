import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `packages/*/dist` covers EVERY workspace package. It used to name only app + fabric, so a
    // test written in any other packages/<pkg>/src/__tests__/ compiled to a path nothing globbed
    // and never ran — 47 files / 238 tests were dead this way, all passing once switched on.
    // A per-package list silently loses coverage every time a package grows its first test.
    include: ["dist/**/__tests__/**/*.test.js", "packages/*/dist/**/__tests__/**/*.test.js", "website/edge/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    testTimeout: 15000,
    watch: false,
    environment: "node",
  },
});
