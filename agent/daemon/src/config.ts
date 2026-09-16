import "dotenv/config";
import { defineChain } from "viem";

/** Arc Testnet — Circle's stablecoin-native L1. USDC is the native currency (6 decimals). */
/**
 * TWO ENDPOINTS, BECAUSE NEITHER DOES BOTH.
 *
 * Measured, not guessed, and the numbers are the whole argument:
 *
 *   drpc                      plain reads fine, 8/8 under load, multicall fine
 *                             getLogs capped somewhere between 100 and 200
 *                             blocks — its refusal claims "over 10000 blocks",
 *                             which is simply untrue, so the message is no
 *                             guide at all
 *
 *   rpc.testnet.arc.network   the only one that will answer a wide getLogs
 *                             at all, and it rate-limits a bare eth_call
 *                             under ordinary use
 *
 * The daemon pointed everything at the second one, because logs are the thing
 * that has no alternative — and so every balance read, every escrow lookup and
 * every milestone fetch queued behind the endpoint that is always busy. A
 * freelancer's dashboard showed a dash where their money should be, and their
 * board could not list a job they had finished, while the browser sitting next
 * to it read the same chain through drpc without trouble.
 *
 * So: reads go to the endpoint that answers reads, logs go to the one that
 * answers logs. Logs are asked for rarely — the delegation sweep keeps a cursor
 * and only walks forward — which is exactly the access pattern the busy
 * endpoint can still serve.
 */
export const rpcUrl = process.env.ARC_RPC_URL?.trim() || "https://rpc.drpc.testnet.arc.network";

/** Where `eth_getLogs` goes. Falls back to the read URL when unset. */
export const logRpcUrl =
  process.env.ARC_LOG_RPC_URL?.trim() || "https://rpc.testnet.arc.network";

export const arcTestnet = defineChain({
  id: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [rpcUrl] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://testnet.arcscan.app" } },
  /* Declared so viem will actually use it — see the note in the app's copy of
     this chain. Without this line every batched read falls back to a loop, and
     the loop is what gets rate-limited. */
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

  // Atelier — Atelier calls this contract, does NOT deploy its own
  atelierAddress: (process.env.ATELIER_CONTRACT_ADDRESS?.trim() ||
    "0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59") as `0x${string}`,
  usdcAddress: (process.env.USDC_ADDRESS?.trim() ||
    "0x3600000000000000000000000000000000000000") as `0x${string}`,

  /**
   * Block the live proxy was deployed at. The token whitelist has to be
   * reconstructed from logs, and public RPCs cap a getLogs range (10k blocks on
   * Arc's free tier), so scanning from genesis is not an option -- and would be
   * 60 million blocks of nothing in any case.
   */
  atelierDeployBlock: BigInt(process.env.ATELIER_DEPLOY_BLOCK?.trim() || "60797735"),
  /** Largest block span this RPC will answer a getLogs call for. */
  logRangeLimit: BigInt(process.env.LOG_RANGE_LIMIT?.trim() || "9000"),
  graphUrl: process.env.GRAPH_URL?.trim() || "",

  /**
   * The Atelier API, which owns the notification store.
   *
   * The daemon needs it to tell web users what the agent did on their behalf —
   * Telegram users already got told, web users got nothing, because
   * notifications were only ever written from the acting party's browser and
   * the agent does not have one.
   */
  apiUrl: (process.env.API_URL?.trim() || "").replace(/\/$/, ""),
  apiSecret: process.env.API_SECRET?.trim() || "",

  // Circle Programmable Wallets (MPC) — the Atelier Agent Wallet treasury.
  circleApiKey: process.env.CIRCLE_API_KEY?.trim() || "",
  circleEntitySecret: process.env.CIRCLE_ENTITY_SECRET?.trim() || "",
  circleWalletId: process.env.CIRCLE_WALLET_ID?.trim() || "",
  circleWalletAddress: (process.env.CIRCLE_WALLET_ADDRESS?.trim() || "") as `0x${string}` | "",
  circleBlockchain: process.env.CIRCLE_BLOCKCHAIN?.trim() || "ARC-TESTNET",

  // Circle Gateway (x402 nanopayments)
  gatewayFacilitatorUrl:
    process.env.GATEWAY_FACILITATOR_URL?.trim() || "https://gateway-api-testnet.circle.com",
  x402OrderFee: process.env.X402_ORDER_FEE?.trim() || "0.05",

  // x402 BUY side — Atelier paying a marketplace service (services/portfolio-check)
  // to verify the leading applicant before hiring. Unset = skip verification.
  portfolioCheckUrl: process.env.PORTFOLIO_CHECK_URL?.trim() || "",

  // Application-level spending policy — the second cage. The Developer-Controlled
  // Wallets SDK has no native policy engine, so Atelier enforces caps itself before
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
   * Where Atelier is served, for links the bot sends into a chat.
   *
   * Configurable because it was hardcoded to a previous product's deployment,
   * so every link the bot sent took a freelancer to the wrong app. A URL that
   * differs per environment does not belong in source.
   */
  publicAppUrl: (process.env.PUBLIC_APP_URL?.trim() || "http://localhost:5173").replace(/\/$/, ""),

  port: Number(process.env.PORT ?? 8787),
};

/** USDC on Arc Testnet has 6 decimals. */
export const USDC_DECIMALS = 6;
