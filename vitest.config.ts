import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "spec", include: ["tests/spec/**/*.test.ts"] } },
      { test: { name: "e2e", include: ["tests/e2e/**/*.test.ts"], testTimeout: 30_000 } },
    ],
  },
});
