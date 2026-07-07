import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // build.test.ts shells out to a full esbuild bundle synchronously
    // (execFileSync) — slow and, under I/O contention from many concurrent
    // worktrees, prone to wedging a worker so the whole run never exits. Keep
    // it out of the fast unit loop; run it via `pnpm test:build` (its own
    // config, vitest.build.config.ts) or `pnpm test:all` before a PR.
    exclude: [...configDefaults.exclude, "**/build.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
    watch: false,
    // This suite is local-only (not in CI) and runs on dev machines that host
    // many concurrent worktrees. Vitest defaults the pool to (cores - 1) — 13
    // workers on a 14-core box — which oversubscribes I/O and can wedge the
    // remaining real-FS tests. Cap the pool so a stuck run leaks 4 workers, not 13.
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
  },
});
