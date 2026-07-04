import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts"],
    // server.test.ts boots the full embedded core (pglite + gating + explorer +
    // MCP + chat + SSE routes, ~1.5s). The default 5s timeout is too tight under
    // parallel-worker contention, so it flakes. Match the root vitest config's
    // 15s budget, which exists for the same class of heavy integration test.
    testTimeout: 15000,
  },
});
