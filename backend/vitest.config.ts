import { defineConfig } from "vitest/config";

// JWT_SECRET is set because lib/env.ts throws at import time without it, and the Module 10
// scoring helpers live in a route file that reaches it through requireAuth.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: { JWT_SECRET: "test-secret" },
  },
});
