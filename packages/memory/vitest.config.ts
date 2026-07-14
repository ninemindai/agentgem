// Copyright (c) 2026 NineMind, Inc.
// SPDX-License-Identifier: MIT
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node", watch: false },
});
