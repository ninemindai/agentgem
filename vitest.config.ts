import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["dist/**/__tests__/**/*.test.js", "website/edge/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    // Redirect HOME/AGENTGEM_HOME to an empty temp store so default-path scans
    // (resolveDirs/agentgemHome) are hermetic — see src/__tests__/support/vitestSetup.ts.
    setupFiles: ["dist/__tests__/support/vitestSetup.js"],
    testTimeout: 15000,
    watch: false,
    environment: "node",
  },
});
