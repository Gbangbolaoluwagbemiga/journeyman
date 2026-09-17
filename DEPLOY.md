# Deploying

Everything on-chain is **already deployed and configured**. This is the runbook
for the parts that need an account only you have, plus how to redo the on-chain
steps if you ever deploy a fresh proxy.

---

## What is live right now

| | |
|---|---|
| Network | Arbitrum Sepolia · chain `421614` |
| Proxy (**the contract**) | `0x5128B3E2a20d483f68834b26505aFD7457C282dc` |
| Implementation | `0x1173Bcc9183f29aFbB6f4C7E3c0b25476D3daF0F` · `4.0.1-journeyman-arbitrum` |
| Deploy block | `309527684` |
| Yield controller | `0x44a4a235DEb0b32929DDA386E9FE931Dd055d0E3` |
| Yield venue | `0xcc116FaD144FFAC4AdD5f97820Cd4C286488e24a` — `UniswapV4StableAdapter` |
| USDC whitelisted | yes — `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| Arbiter authorised | yes — `0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41` |
| Escrows | none — clean history |

All four contracts are verified on Arbiscan.

Check any of it yourself rather than believing this table:

```bash
RPC=https://sepolia-rollup.arbitrum.io/rpc
P=0x5128B3E2a20d483f68834b26505aFD7457C282dc
cast call $P "version()(string)"                 --rpc-url $RPC
cast call $P "owner()(address)"                  --rpc-url $RPC
cast call $P "getArbiters()(address[])"          --rpc-url $RPC
cast call $P "whitelistedTokens(address)(bool)" 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d --rpc-url $RPC
```

The last two were both wrong on the live proxy for a day after deployment —
`false` and `[]` — which does not fail at deploy time and does not fail at
boot. It fails the first time a real person tries to post a job, or the first
time a dispute needs somebody to rule on it. **Run those four calls after every
deploy.**

---

## Running the whole thing locally

Proven end to end on Arbitrum Sepolia — browser → Vite → daemon → SQLite, with
nothing stubbed. The daemon needs almost nothing to stand up; the keys it is
missing disable features and it says which, rather than failing to boot.

```bash
# 1. agent/daemon/.env — enough to boot and read the chain
cat > agent/daemon/.env <<'ENV'
ARB_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
JOURNEYMAN_CONTRACT_ADDRESS=0x5128B3E2a20d483f68834b26505aFD7457C282dc
USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
JOURNEYMAN_DEPLOY_BLOCK=309527684
PORT=8799
ENV
(cd agent/daemon && npm start)      # creates data/journeyman.db on first boot

# 2. Demo rows for the decision log. Local SQLite only — nothing on a chain.
node scripts/seed-local-demo.mjs

# 3. app/.env, then the dev server
#    VITE_AGENT_API_URL=http://localhost:8799 is what un-gates Autopilot
(cd app && npm run dev -- --port 5174)

# 4. The full browser suite
(cd app && npm run e2e)             # 43 pass, 5 deferred
```

Without `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` it holds no wallet and signs
nothing; without `GROQ_API_KEY` it makes no hiring decision; without `API_URL`
the notification bell never fires. It logs each of those on boot.

Watch the first lines it prints. `disputeBackfill` running to `done` is the
windowed log walk completing — the one that was sized for a chain producing
half as many blocks per second and silently covered a third of the day it
claimed.

---

## Rotate the deploy key

`0x3Be7fbBDbC73Fc4731D60EF09c4BA1A94DC58E41` is the deployer, and its private
key was visible in a screenshot shared during an earlier build. The balance is
faucet money, but that address also **owns the upgradeable proxy** — and the
owner can replace the implementation over live escrows.

That is a different risk class from a testnet balance. Generate a fresh key,
fund it, deploy a fresh proxy from it, and point everything at that one.

```bash
cast wallet new
# gas:  https://faucet.quicknode.com/arbitrum/sepolia
# USDC: https://faucet.circle.com  (pick Arbitrum Sepolia)
```

---

## Redeploying the contract from scratch

```bash
cd app/contracts/solidity
set -a && . ./.env && set +a

forge test                                                  # 186 must pass first
forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia # simulate
forge script script/Deploy.s.sol --rpc-url arbitrum_sepolia --broadcast --verify
```

It prints two addresses. **The PROXY is the contract** — the implementation
changes on every upgrade, the proxy never does. Everything points at the proxy.

Then, in this order, because none of them fail loudly if skipped:

```bash
# 1. Whitelist USDC, or createEscrow reverts with TokenNotWhitelisted for
#    every job anybody tries to post.
JOURNEYMAN_ADDRESS=<PROXY> forge script script/WhitelistUSDC.s.sol \
  --rpc-url arbitrum_sepolia --broadcast

# 2. Authorise an arbiter, or a dispute has nobody who can resolve it and the
#    money sits until the emergency window opens.
cast send <PROXY> "authorizeArbiter(address)" <YOUR_ADDRESS> \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc --private-key "$PRIVATE_KEY"

# 3. Attach the yield leg: deploys JourneymanYield, deploys the v4 adapter,
#    opens the USDT/USDC pool if nobody has, and wires the two together.
PROXY_ADDRESS=<PROXY> forge script script/DeployYieldArbitrum.s.sol \
  --rpc-url arbitrum_sepolia --broadcast --verify
```

Point the app at it — `app/.env`:

```env
VITE_JOURNEYMAN_CONTRACT_ADDRESS=<PROXY>
VITE_USDC_TOKEN_CONTRACT=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
```

…and `backend/.env` and `agent/daemon/.env` (`CONTRACT_ADDRESS`,
`JOURNEYMAN_CONTRACT_ADDRESS`, `JOURNEYMAN_DEPLOY_BLOCK`).

### Upgrading, rather than redeploying

```bash
forge test --match-path test/JourneymanUpgrade.t.sol   # these must pass
PROXY_ADDRESS=<PROXY> forge script script/Upgrade.s.sol \
  --rpc-url arbitrum_sepolia --broadcast --verify
```

Bump `version()` in the same commit. A bad upgrade does not revert — it
reinterprets live escrow storage under the new layout and keeps going, with
wrong numbers and real money behind them.

---

## The subgraph (Subgraph Studio)

The manifest already targets `arbitrum-sepolia` at the live address and start
block. What is left is an account step.

1. [Subgraph Studio](https://thegraph.com/studio/), connect a wallet.
2. **Create a Subgraph**, name it `journeyman`, network **Arbitrum Sepolia**.
3. Copy the **deploy key**.

```bash
cd subgraph
npm run auth -- <DEPLOY_KEY>
npm run codegen
npm run build
npm run deploy:studio          # asks for a version label, e.g. v0.0.1
```

Studio then shows a **query URL** with an API key in it.

### After it syncs

1. Put the query URL in `app/.env` (`VITE_GRAPH_URL`) and `agent/daemon/.env`
   (`GRAPH_URL`). Both are deliberately blank today: blank means the app falls
   back to RPC multicall against the contract it is actually pointed at, which
   is correct but slower. A URL pointing at a subgraph for a DIFFERENT contract
   is worse than blank — it renders a list of escrow ids that do not exist,
   each showing "0 USDC / No description available".

2. **Use a rate-limited key.** `VITE_GRAPH_URL` ships inside the browser bundle
   — anyone can read it out of your JS. Studio lets you cap a key by domain and
   by rate; do that rather than shipping an unrestricted one.

3. Check it returns escrows rather than an error:

```bash
curl -s <QUERY_URL> -H 'Content-Type: application/json' \
  -d '{"query":"{ escrows(first:3){ id jobManager } }"}'
```

---

## Google sign-in for managed wallets

The managed-worker door provisions a Circle MPC wallet, so it needs to know who
somebody is before it hands them one. Without this configured the door is
closed rather than open — an unauthenticated wallet service is worse than none.

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) →
   **Create credentials** → **OAuth client ID** → **Web application**.
2. Authorised JavaScript origins: `http://localhost:5174` for local, plus your
   deployed origin.
3. Copy the **client ID** (the `.apps.googleusercontent.com` one). There is no
   secret to copy — this flow verifies a signed token rather than exchanging a
   code, so nothing confidential ends up in the browser.

```env
# app/.env
VITE_GOOGLE_CLIENT_ID=…apps.googleusercontent.com

# agent/daemon/.env  — the SAME id
GOOGLE_CLIENT_ID=…apps.googleusercontent.com
```

The daemon uses it as the expected **audience** when verifying tokens. Getting
that check wrong is what turns any Google-signed token on the internet into a
valid login here, so the two values must match exactly.

---

## Funding the treasury

Gas and money are different assets here, which they were not on the chain this
was ported from. The daemon's Circle wallet needs **both**:

  - **ETH** — every transaction it signs on anybody's behalf, plus the drip
    that lets a new managed worker sign their first application.
  - **USDC** — the job budgets it funds escrows with.

A treasury holding only USDC looks funded on every dashboard and cannot send a
single transaction.

---

## What is still true afterwards

Deploying does not make the product trustless. The owner of that proxy can ship
a new implementation over live escrows. That is the standard arrangement and it
is fine, but the honest sentence stays:

> The contract cannot take your money, and the owner can change the contract.

Keep the second clause in the submission.
