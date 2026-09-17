import "dotenv/config";
import { defineChain } from "viem";

/**
 * ONE ENDPOINT, BECAUSE ARBITRUM'S DOES BOTH.
 *
 * The previous chain needed two. Its drpc endpoint answered plain reads all day, capped
 * eth_getLogs somewhere under 200 blocks while claiming the limit was 10,000;
 * its public endpoint was the only one that would walk a real log range and it
 * rate-limited a bare eth_call. Reads and logs had to be split across the two,
 * and the split is deleted here because Arbitrum's public RPC serves both.
 *
 * If that ever stops being true, the fix is a paid endpoint in ARB_RPC_URL —
 * not a second client.
 */
export const rpcUrl =
  process.env.ARB_RPC_URL?.trim() || "https://sepolia-rollup.arbitrum.io/rpc";

export const arbitrumSepolia = defineChain({
  id: Number(process.env.CHAIN_ID ?? 421614),
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" } },
  /* Declared so viem will actually use it. Arbitrum has multicall3 at the
     canonical address like everywhere else; the reason this line exists is that
     viem refuses a contract the chain has not declared, and without it every
     batched read silently becomes a loop. */
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || "",

  // Groq — temporary stand-in LLM provider while the Anthropic account has no
  // credit balance. Same call shape (structured JSON), swap back by pointing
  // agent/* at the Anthropic client again once billing is sorted.
  groqApiKey: process.env.GROQ_API_KEY?.trim() || "",
  // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16. Anything
  // still defaulting to it fails closed with no served model.
  groqModel: process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b",
  groqFallbackModel: process.env.GROQ_FALLBACK_MODEL?.trim() || "openai/gpt-oss-20b",
  /**
   * The score an applicant must reach to be hired.
   *
   * Configurable because it is MODEL-DEPENDENT, which is not obvious and cost a
   * near-outage to learn. Re-scoring 25 historical applications when
   * llama-3.3-70b was decommissioned showed gpt-oss-120b running a mean 10
   * points lower on the same letters — at a fixed bar of 70 that took hiring
   * from 9 of 9 down to 1, while every surface still reported healthy.
   *
   * Any model swap must be re-calibrated against scoring history before it is
   * trusted. The bar is not a product decision; it is a property of the model.
   */
  hireScoreThreshold: Number(process.env.HIRE_SCORE_THRESHOLD ?? 55),

  // Journeyman — Journeyman calls this contract, does NOT deploy its own
  journeymanAddress: (process.env.JOURNEYMAN_CONTRACT_ADDRESS?.trim() ||
    "0x5128B3E2a20d483f68834b26505aFD7457C282dc") as `0x${string}`,
  usdcAddress: (process.env.USDC_ADDRESS?.trim() ||
    "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d") as `0x${string}`,

  /**
   * Block the live proxy was deployed at. The token whitelist has to be
   * reconstructed from logs, and public RPCs cap a getLogs range, so scanning
   * from genesis is not an option -- and would be 300 million blocks of nothing
   * in any case.
   */
  journeymanDeployBlock: BigInt(process.env.JOURNEYMAN_DEPLOY_BLOCK?.trim() || "309527684"),
  /** Largest block span this RPC will answer a getLogs call for. */
  logRangeLimit: BigInt(process.env.LOG_RANGE_LIMIT?.trim() || "100000"),
  graphUrl: process.env.GRAPH_URL?.trim() || "",

  /**
   * Block explorer, no trailing slash. Every "see it on chain" link the daemon
   * sends — in Telegram, in the payment feed, on the wallet card — is built
   * from this. It was hardcoded to the old chain's explorer in five places,
   * which is five dead links to hand a judge.
   */
  explorerBaseUrl: (process.env.EXPLORER_BASE_URL?.trim() || "https://sepolia.arbiscan.io").replace(/\/$/, ""),

  /**
   * The Journeyman API, which owns the notification store.
   *
   * The daemon needs it to tell web users what the agent did on their behalf —
   * Telegram users already got told, web users got nothing, because
   * notifications were only ever written from the acting party's browser and
   * the agent does not have one.
   */
  apiUrl: (process.env.API_URL?.trim() || "").replace(/\/$/, ""),
  apiSecret: process.env.API_SECRET?.trim() || "",

  // Circle Programmable Wallets (MPC) — the Journeyman Agent Wallet treasury.
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  circleWalletId: process.env.CIRCLE_WALLET_ID?.trim() || "",
  circleWalletAddress: (process.env.CIRCLE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARB-SEPOLIA",

  // Circle Gateway (x402 nanopayments)
  gatewayFacilitatorUrl:
    process.env.GATEWAY_FACILITATOR_URL?.trim() || "https://gateway-api-testnet.circle.com",
  x402OrderFee: process.env.X402_ORDER_FEE?.trim() || "0.05",

  // x402 BUY side — Journeyman paying a marketplace service (services/portfolio-check)
  // to verify the leading applicant before hiring. Unset = skip verification.
  portfolioCheckUrl: process.env.PORTFOLIO_CHECK_URL?.trim() || "",

  // Application-level spending policy — the second cage. The Developer-Controlled
  // Wallets SDK has no native policy engine, so Journeyman enforces caps itself before
  // every signed spend (see circle/gateway.ts).
  dailySpendCapUsdc: Number(process.env.DAILY_SPEND_CAP_USDC ?? 50),
  x402BuySpendCapUsdc: Number(process.env.X402_BUY_SPEND_CAP_USDC ?? 5),

  // Hard ceiling on any single commission, enforced before escrow is opened.
  // The budget in a brief is produced by an LLM, and an LLM will happily invent
  // one: a live e2e run asking for a "$1" logo came back with milestones of
  // $50/$25/$25 and tried to lock $100. That attempt only failed because the
  // treasury was too small to cover it — with a funded wallet it would have
  // quietly locked 100x the requested amount.
  maxJobBudgetUsdc: Number(process.env.MAX_JOB_BUDGET_USDC ?? 100),

  // How long a job stays open for applications before the agent judges.
  //
  // Without a window, scoring fired the moment the FIRST application landed and
  // hired anyone clearing the bar — so the job went to whoever was fastest, not
  // whoever was best, and the "one comparative call ranking applicants against
  // each other" only ever compared a pool of one. A marketplace that rewards
  // refresh speed over skill is not the marketplace we claim to be building.
  //
  // Short by default because a hackathon demo cannot wait an hour; a real
  // deployment would set this far higher, and a client can already ask for
  // longer in their instruction.
  applicationWindowMinutes: Number(process.env.APPLICATION_WINDOW_MINUTES ?? 3),

  // Managed-worker layer. All worker wallets live in one Circle wallet set,
  // separate from the treasury's. Set this after the first signup creates it, so
  // a restart reuses the same set instead of making a new one each boot.
  workerWalletSetId: process.env.WORKER_WALLET_SET_ID?.trim() || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || "",

  /**
   * Google OAuth client id, used to VERIFY sign-in tokens rather than to issue
   * them. Unset means the managed-worker door is closed rather than open — an
   * unauthenticated wallet service is worse than no wallet service.
   */
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || "",

  /**
   * Where Journeyman is served, for links the bot sends into a chat.
   *
   * Configurable because it was hardcoded to a previous product's deployment,
   * so every link the bot sent took a freelancer to the wrong app. A URL that
   * differs per environment does not belong in source.
   */
  publicAppUrl: (process.env.PUBLIC_APP_URL?.trim() || "http://localhost:5173").replace(/\/$/, ""),

  port: Number(process.env.PORT ?? 8787),
};

/** USDC on Arbitrum Sepolia has 6 decimals. */
export const USDC_DECIMALS = 6;
