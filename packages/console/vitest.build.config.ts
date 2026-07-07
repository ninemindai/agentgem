import { defineConfig } from "vitest/config";

// Dedicated config for the heavy build test, kept out of the fast unit loop.
// build.test.ts runs a full esbuild client bundle synchronously, so it gets its
// own single-file run (invoked via `pnpm test:build` / `pnpm test:all`) instead
// of competing for a worker slot in the main pool.
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/__tests__/build.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
  },
});
