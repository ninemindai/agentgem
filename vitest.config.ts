import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["dist/**/__tests__/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    testTimeout: 15000,
    watch: false,
  },
});
