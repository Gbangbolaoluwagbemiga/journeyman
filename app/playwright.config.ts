import { defineConfig, devices } from "@playwright/test";

/**
 * Full-stack end-to-end tests.
 *
 * These drive a real browser against a real Vite build, a real Express backend
 * and the real Patron daemon. They are the only tests in this repo that would
 * catch the failures which live BETWEEN the pieces — a route that 404s, a CORS
 * header the daemon stopped sending, an ABI the frontend can no longer encode
 * against, a component that throws only once React actually mounts it.
 *
 * The unit tests all pass with the daemon switched off. That is the point of
 * them, and it is also their limit.
 *
 * Not covered here, deliberately: anything requiring a connected wallet.
 * Automating a wallet extension is a large amount of fragile machinery, and the
 * contract-level journeys in contracts/solidity/test/AtelierE2E.t.sol already
 * walk every on-chain path end to end against a real proxy. What is left for the
 * browser is everything up to the signature prompt.
 */
export default defineConfig({
  testDir: "./e2e",
  // The screenshot harness is not a test — it exists to capture the LLM-backed
  // screens for review, and it costs a generation round trip every run.
  testIgnore: ["**/shots/**", "**/capture/**"],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 30_000,

  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
});
