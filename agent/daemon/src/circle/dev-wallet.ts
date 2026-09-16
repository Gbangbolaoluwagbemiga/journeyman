import "dotenv/config";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * A SEPARATE AGENT WALLET FOR LOCAL DEVELOPMENT.
 *
 *   npm run circle:dev-wallet
 *
 * WHY THIS EXISTS
 *
 * A local daemon and the hosted one were running with the same CIRCLE_WALLET_ID,
 * so both resolved to the same on-chain identity and both polled the same chain.
 * Every open job was being worked by two agents that could not see each other:
 * the dedup markers that stop repeated work live in each daemon's own SQLite, so
 * neither knew the other had already acted.
 *
 * It was not theoretical. Escrow 7's single applicant was scored by both — 25 by
 * one and 70 by the other, from briefs each had generated independently — and the
 * one that scored 70 hired them. A person's job depended on which daemon won a
 * race. The same collision showed up in Telegram as "Conflict: terminated by
 * other getUpdates", which is easy to read as noise and was in fact the only
 * visible symptom.
 *
 * This provisions a second MPC wallet in the SAME Circle wallet set, so the
 * existing policies and entity secret carry over, and prints env lines meant for
 * daemon/.env ONLY. Putting them on the hosted deployment would recreate exactly
 * the collision this exists to remove.
 */
async function main() {
  const { circleApiKey: apiKey, circleEntitySecret: entitySecret, circleWalletId } = config;

  if (!apiKey || !entitySecret) {
    console.error("✗ Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET in daemon/.env first.");
    process.exit(1);
  }
  if (!circleWalletId) {
    console.error(
      "✗ CIRCLE_WALLET_ID is not set, so there is no wallet set to add to.\n" +
        "  Run `npm run circle:setup` instead — that provisions the first one.",
    );
    process.exit(1);
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  /* Read the set off the wallet already in use rather than asking for it. The
     point is to sit beside the production wallet, and a set id typed by hand is
     a way to quietly end up somewhere else. */
  console.log("→ Looking up the wallet set the current agent wallet belongs to…");
  const current: any = await client.getWallet({ id: circleWalletId });
  const walletSetId: string | undefined = current?.data?.wallet?.walletSetId;
  if (!walletSetId) throw new Error("could not read walletSetId from CIRCLE_WALLET_ID");

  console.log(`→ Creating a second MPC wallet on ${config.circleBlockchain} in that set…`);
  const created: any = await client.createWallets({
    walletSetId,
    blockchains: [config.circleBlockchain as never],
    count: 1,
    accountType: "EOA",
    /* Circle rejects the call outright without one, with a bare "Something went
       wrong" and an error id — nothing that points at the missing field. */
    idempotencyKey: randomUUID(),
  } as never);
  const wallet = created?.data?.wallets?.[0];
  if (!wallet?.address) throw new Error("no wallet returned");

  console.log("\n✅ Local agent wallet created — key shares held by Circle, no raw key here.\n");
  console.log("   wallet id : " + wallet.id);
  console.log("   address   : " + wallet.address);
  console.log("   in set    : " + walletSetId);
  console.log("   production wallet stays: " + (config.circleWalletAddress || "(unset)"));

  console.log("\n── Put these in agent/daemon/.env — LOCAL ONLY ──");
  console.log(`CIRCLE_WALLET_ID=${wallet.id}`);
  console.log(`CIRCLE_WALLET_ADDRESS=${wallet.address}`);
  console.log(
    "\n⚠  Do NOT set these on Railway. The hosted daemon must keep the original\n" +
      "   wallet, or both will be the same agent again and race on every job.\n",
  );
  console.log("Next: send that address a little testnet USDC on Arc for gas and hiring,");
  console.log("then start the local daemon. It will act as its own agent from then on.\n");
}

main().catch((e) => {
  console.error("✗ circle:dev-wallet failed:", e?.response?.data ?? e?.message ?? e);
  process.exit(1);
});
