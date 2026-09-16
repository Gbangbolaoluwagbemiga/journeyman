import { defineConfig } from "vitest/config";

/**
 * The daemon had no tests at all for its first 27 source files — the scorer,
 * the delegation sweep, the chain fallback, every call that releases somebody's
 * money — while the contract it drives had 115. This is the config that ends
 * that, deliberately narrow: unit tests over pure logic and over modules whose
 * network edges can be faked, with no live RPC and no LLM in the loop.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
