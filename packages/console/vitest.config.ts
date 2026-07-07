import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
    // This suite is local-only (not in CI) and runs on dev machines that host
    // many concurrent worktrees. Vitest defaults the pool to (cores - 1) — 13
    // workers on a 14-core box — which oversubscribes I/O and can wedge the
    // real-FS/build tests (e.g. build.test.ts shells out to a full esbuild
    // bundle synchronously). A wedged worker keeps the run from exiting, which
    // orphans the whole pool. Cap the pool so a stuck run leaks 4 workers, not 13.
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
  },
});
