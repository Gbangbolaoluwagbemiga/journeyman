# What Atelier is submitting for, and where to verify it

Atelier is entered as a **from-scratch** project. It is not registered under the
Continuity track, so every Continuity-only prize below is marked ineligible
rather than claimed.

Three partners: **Arc (Circle)**, **The Graph**, **Uniswap**.

Every claim here names the file and line that backs it. If a line does not say
what this page says it says, the claim is wrong and should be scored as wrong.

---

## Arc / Circle

### 🏆 Best Agentic Economy Application with Circle Agent Stack — $1,667

The strongest fit. Atelier is an agent that holds a wallet, decides who to hire
from real signals, and settles the job in USDC.

| What they asked for | Where it is |
|---|---|
| Agents with clear decision logic tied to real signals | [`ApplicationScorer.ts`](../agent/daemon/src/agent/ApplicationScorer.ts) scores every applicant in one comparative call. The signals are on-chain history and fetched portfolio evidence, not self-reported claims — [`ApplicantEvidence.ts`](../agent/daemon/src/agent/ApplicantEvidence.ts) |
| Autonomous spending, payments or settlement in USDC | The agent calls `approveMilestone`, which releases USDC to the freelancer — [`atelier.ts`](../agent/daemon/src/web3/atelier.ts). On Arc, USDC is the native currency, so this is settlement, not a token transfer beside it |
| Agent Stack connecting agents to wallets and on-chain actions | Circle Programmable Wallets (MPC) sign every agent action — [`circleSigner.ts:94`](../agent/daemon/src/circle/circleSigner.ts#L94). A wallet is also minted per freelancer so someone with no crypto can be paid — [`wallets.ts`](../agent/daemon/src/workers/wallets.ts) |
| Agent-to-agent or service payments | x402 both ways. An AI agent pays Atelier to commission a job — [`x402-seller.ts:21`](../agent/daemon/src/circle/x402-seller.ts#L21). Atelier pays marketplace services through Gateway — [`gateway.ts`](../agent/daemon/src/circle/gateway.ts) |

**The part worth reading the code for:** an Autopilot manager can hire, approve,
reject and escalate, and there is no path by which value reaches it. Enforced at
two points — [`Atelier.sol:833`](../app/contracts/solidity/src/Atelier.sol#L833)
(a manager cannot be the beneficiary) and
[`Atelier.sol:797`](../app/contracts/solidity/src/Atelier.sol#L797) (it cannot
appoint itself the freelancer on an open job). Fuzzed at 128,000 calls against a
handler that deliberately attempts every forbidden move —
[`JobManagerInvariant.t.sol`](../app/contracts/solidity/test/JobManagerInvariant.t.sol).

### 🏆 Best DeFi / Onchain Finance Application — $1,667

| What they asked for | Where it is |
|---|---|
| Meaningful use of Arc and USDC | Every escrow is USDC on Arc. The whole product is settlement |
| Conditional payments, on-chain automation, multi-step settlement | Milestone escrow: funds lock before a job is visible, and release per milestone against criteria the client approved. Disputes go to a multi-arbiter vote with a confirmation threshold — [`Atelier.sol`](../app/contracts/solidity/src/Atelier.sol) |
| Treasury workflows | Per-client deposit balances, signed like a withdrawal so nobody spends against someone else's deposit — [`index.ts`](../agent/daemon/src/index.ts) |
| Why stablecoin-native infrastructure changes what is possible | **The platform fee is not charged.** A client who lets their escrow work approves 2.5% less; the platform takes 40% of what the escrow earns instead, and the freelancer 60%. Money sitting between funding and approval goes to a stable-stable LP, with the investable ceiling derived from the largest imminent claim rather than a percentage — [`AtelierYield.sol`](../app/contracts/solidity/src/yield/AtelierYield.sol), [`FeeWaiver.t.sol`](../app/contracts/solidity/test/FeeWaiver.t.sol) |

**The version that did not work, stated because it is the interesting part.**
The fee was charged and the yield refunded it later. That refund is worth
nothing: covering a 2.5% fee needs `rate × days ≥ 22.8` — 228 days at 10% APY,
with the budget cancelling out of the inequality entirely. No freelance job is
long enough, so no client had a reason to opt in and the screen offering it was
misleading. Waiving the fee outright is the second answer, and it is the one a
client can see in their wallet.

**The invariant that had to be weakened, stated honestly:** cash plus deployed
capital never falls below what is owed. A failing venue can *delay* a payout; it
cannot lose the money. The stronger claim we first wrote was false, and a fuzzer
found it — the story is in the README.

### 🏆 Launch on Arc Testnet & Push to Mainnet — $3,500

Live on Arc testnet now, upgradeable in place, with the mainnet path already
exercised: the proxy has been upgraded five times without losing an escrow.

| | |
|---|---|
| Proxy (the address that matters) | `0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE` |
| Implementation | `3.8.0-fee-waived-for-work` |
| Yield controller | `0x44E5e128B084750694BB0B295713832cfe1750bB` — the 60/40 split, fixed at posting time |
| Testnet yield venue | `0xe6775B67963efE7e9F4B4e1621Ec08f8DAf97907` — `SponsoredVault`, sponsored not earned, and it says so |
| The yield term | Chosen once while posting; the contract refuses to change it after a hire |
| Escrows settled | Real jobs, funded and hired by the agent |

**Outstanding:** deployment to Arc mainnet by 30 September. The contract is
mainnet-ready — UUPS, 99 Foundry tests, a storage gap with append-only
discipline, and an upgrade script whose first act is to assert the escrow
counter did not move.

### ⛔ Best DeFi or Agentic Application ($1,666) — not eligible

Continuity-track only. Atelier is registered from scratch.

### ⛔ Launch on Arc, Continuity ($1,500) — not eligible

Same reason.

---

## The Graph

### 🤖 Best AI Tooling or AI Use Case — From Scratch pool — $5,000

**Pool: Start Fresh.** Begun and built during the event.

| What they asked for | Where it is |
|---|---|
| The Graph load-bearing | The agent asks the subgraph who applied before it can score anyone — [`AgentClient.ts:126`](../agent/daemon/src/agent/AgentClient.ts#L126). Remove it and the hire loop has no input |
| Live data from a Graph provider | Subgraph Studio, deployed on Arc: [`atelier/v0.0.3`](https://api.studio.thegraph.com/query/1759977/atelier/v0.0.3). Not mocked, not local |
| Meaningful work with the data — reasoning, decisions, automation | The query result is the input to a hiring decision that moves USDC. The agent reads every applicant *together*, ranks them, hires one, and releases payment. The full reasoning is published per job in the decision log |
| Open source, README, public repo | This repository |

**What makes this more than "an app that queries a subgraph":** the consumer is
an autonomous agent, not a dashboard. The subgraph is what it perceives with —
job state, who applied, what they wrote, which milestone is outstanding — and
the output is money moving to a person.

**The index does work, not just mirroring.** Two fields exist only because the
mapping computes them at index time. `projectTitle` is not in the
`EscrowCreated` event at all, so the handler reads it back off the contract —
without that, every indexed job is untitled. And `category` is lifted out of a
marker in the job's description rather than stored on-chain, because a category
changes nothing about how money moves and the escrow is 415 bytes short of
EIP-170. Spending an upgrade and a storage slot on a browsing aid would have
been the wrong trade; putting the extraction in the index was the right one —
[`mapping.ts`](../subgraph/src/mapping.ts).

**Degrading honestly.** If the subgraph is unreachable, single-escrow reads fall
back to the chain — [`chain-fallback.ts`](../agent/daemon/src/graph/chain-fallback.ts).
The Graph makes the loop fast; it should not be the reason a freelancer goes
unpaid.

### ⛔ Best Use of Composable or Standardized Graph Products ($5,000) — not eligible

Stated plainly because the rules say so: *"Simply querying one Subgraph with no
composition or standardization does not qualify."* Atelier ships one purpose-built
subgraph. It composes no second Graph product and implements no standardized
schema, so this prize is not claimed.

### ⛔ AI Tooling, Continuity pool ($5,000) — not eligible

We are in the Start Fresh pool.

---

## Uniswap

### 🦄 Best Uniswap Stack Contribution — $3,000

**The contribution: escrow TVL as patient liquidity.** Escrowed money sits still
between a job being funded and a milestone being approved — often weeks. That is
exactly the demand v4 liquidity wants: patient, stable-denominated, with a known
exit date.

| What they asked for | Where it is |
|---|---|
| Build on or integrate the Uniswap stack (v4) | [`UniswapV4StableAdapter.sol`](../app/contracts/solidity/src/yield/UniswapV4StableAdapter.sol) — mints and burns a real position through `unlock` → `modifyLiquidity` → `settle`/`take`. The callback is at [line 309](../app/contracts/solidity/src/yield/UniswapV4StableAdapter.sol#L309), `modifyLiquidity` at [line 318](../app/contracts/solidity/src/yield/UniswapV4StableAdapter.sol#L318) |
| Public repo, open source | This repository, MIT |
| `FEEDBACK.md` | [`FEEDBACK.md`](../FEEDBACK.md) |

**Proven against the real PoolManager, not a mock.** 11 fork tests against the
live v4 deployment on Base and the existing USDC/USDT pool there — a 1,000 USDC
deposit that mints liquidity, and a withdraw that returns exactly what was asked:

```bash
FOUNDRY_PROFILE=fork forge test --match-path test/UniswapV4Fork.t.sol \
  --fork-url https://mainnet.base.org
```

**Two design decisions worth a judge's attention.**

*Single-sided, on purpose.* The escrow holds one asset and owes that same asset
back. Providing two-sided liquidity would put a freelancer's principal through a
swap, and a swap can lose money. The range sits entirely to one side of the
price, and `configurePool` rejects a range that straddles it.

*Where the reserve number comes from.* The usual objection to a vault lending
somebody else's escrow is that it is a rule engine wearing a hat — a few
thresholds a person picked. That was true of our first version, and a fuzzer
broke it in a few thousand calls: it kept a flat 20% buffer, and milestones are
not 20% of an escrow, so it could not pay a 50% milestone with the venue down.
The cap is now **derived** — the largest claim that could arrive next, read from
the escrow's own milestones, with the percentage on top rather than instead. A
threshold is an opinion about risk; a derived reserve answers "what is the worst
thing that can be asked of me next", and it keeps holding when the escrow's
shape changes. See [`AtelierYield.sol`](../app/contracts/solidity/src/yield/AtelierYield.sol),
`investableCeiling`, and section 4 of [`FEEDBACK.md`](../FEEDBACK.md).

*Why it is not attached to the live escrow.* Uniswap v4 is not on Arc testnet,
and it cannot be: `PoolManager` takes its lock with `TSTORE`, so it needs a
cancun chain. Arc mainnet opens 2026-09-16. The adapter is therefore written,
fork-proven, and deliberately unattached — `deposit()` reverts until a pool is
configured, because an adapter that guesses at a pool would move real money into
one nobody chose.

### ⛔ Uniswap Stack Contribution, Continuity ($2,000) — not eligible

Continuity-track only.

---

## Submission checklist

| | Status |
|---|---|
| Working frontend and backend | Done — web app on Vercel, API on Railway |
| Architecture diagram | Done — [README](../README.md#architecture), plus the settlement sequence |
| Public GitHub repo | Done |
| `FEEDBACK.md` | Done |
| Live subgraph on Subgraph Studio | Done — `atelier/v0.0.3`, indexing Arc |
| Autopilot daemon hosted | Done — Railway container, volume at `/app/data`, [`/healthz`](https://independent-presence-production-952d.up.railway.app/healthz) |
| Uniswap Developer Feedback Form | **Outstanding** — must link to `FEEDBACK.md` |
| Demo video, 2–4 minutes | **Outstanding** |
| Arc mainnet deploy by 30 September | **Outstanding** |

The daemon is now hosted, which was the one outstanding item that cost points
rather than tidiness: the Circle Agent Stack prize is about an agent that
transacts, and a judge clicking the deployed link now reaches one that does.
On its first boot it discovered a delegated escrow from chain logs alone —
[`adoptDelegated.ts`](../agent/daemon/src/agent/adoptDelegated.ts).
