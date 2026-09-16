# FEEDBACK.md — building productive escrow on the Uniswap stack

Required by the Uniswap Foundation track. Written for ETHOnline 2026 by the
team behind [Atelier](https://github.com/Gbangbolaoluwagbemiga/Atelier) —
milestone escrow on Arc where the client can be a person or an AI agent.

**What we built:** escrowed capital sits idle between a job being funded and a
milestone being approved, often for weeks. We routed that idle capital into a
Uniswap v4 stable-stable position, under a hard rule that it must never delay
paying a freelancer.

**Where the code is:**

| | |
|---|---|
| Adapter interface | [`src/yield/IYieldAdapter.sol`](app/contracts/solidity/src/yield/IYieldAdapter.sol) |
| Uniswap v4 adapter | [`src/yield/UniswapV4StableAdapter.sol`](app/contracts/solidity/src/yield/UniswapV4StableAdapter.sol) |
| Escrow-side policy | [`src/yield/AtelierYield.sol`](app/contracts/solidity/src/yield/AtelierYield.sol) — `investableCeiling`, `investableAmount`, `ensureLiquid`, `onObligationChanged` |
| Escrow-side wiring | [`src/Atelier.sol`](app/contracts/solidity/src/Atelier.sol) — `releaseToYield`, `_rebalanceYield`, `_ensureLiquid` |
| Tests | [`test/ProductiveEscrow.t.sol`](app/contracts/solidity/test/ProductiveEscrow.t.sol), [`test/ProductiveEscrowInvariant.t.sol`](app/contracts/solidity/test/ProductiveEscrowInvariant.t.sol) |

---

## 1. v4 is not on Arc testnet, and that shaped the whole build

Atelier's escrows live on **Arc testnet** (chain `5042002`). v4's PoolManager is
deployed on **Arc mainnet** (`0x8366a39cc670b4001a1121b8f6a443a643e40951`), which
opens 2026-09-16 — submission day.

We checked directly rather than trusting a docs table:

```bash
cast code 0x8366a39cc670b4001a1121b8f6a443a643e40951 --rpc-url <arc-testnet>
# 0x  — no code
```

**The friction:** a team building on a chain during its testnet phase cannot
integrate v4 there at all, and only finds out by probing addresses. A
`v4-deployments.json` in `Uniswap/v4-periphery`, or a documented testnet
PoolManager per chain, would have saved us half a day. The Sepolia deployments
we eventually fork-tested against were found via GitHub search, not docs.

**Concrete ask:** publish testnet PoolManager addresses in the same table as
mainnet, and mark chains where v4 is mainnet-only. "Uniswap is on Arc" is true
and was, for us, misleading.

## 2. v4-core is a heavy dependency for an integrator who only deposits

Our adapter needs to add and remove liquidity and read a position's value. It
does not construct `PoolKey`s, write hooks, or touch `BalanceDelta` maths. But
importing `v4-core` for the interfaces pulls a large tree into a contract that
holds other people's money, and every transitive dependency is something we now
have to justify in an audit.

We ended up **declaring a three-line local `IPoolManager`** instead:

```solidity
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
}
```

That works, and it is also exactly the pattern that goes stale silently when the
upstream signature changes.

**Concrete ask:** ship a `v4-interfaces` package — types and interfaces only, no
libraries, no implementations. Integrators who deposit into pools rather than
build hooks are a large audience, and right now the smallest correct dependency
is one we hand-wrote.

## 3. The unlock/callback pattern is hard to reason about from a vault

v4's flash accounting is elegant for routers and painful for a contract whose
job is "hold this money safely". Our escrow must guarantee that a withdrawal
either returns the exact amount or reverts — and expressing that through
`unlock()` → callback → settle means the guarantee lives across a callback
boundary, in a different frame from the function that promised it.

We handled it by making the adapter assert its own postcondition:

```solidity
if (recovered < assets) revert ShortfallOnWithdraw(assets, recovered);
```

**The friction:** there is no canonical example of a *custodial* v4 integration —
something that holds third-party funds and needs exact-amount withdrawals. Every
example in the docs is a swapper or a hook. The gap between "here is how to
swap" and "here is how to safely custody LP positions on behalf of users" is
where we spent most of our time.

**Concrete ask:** an official example of a v4-backed ERC-4626-style vault, with
the exact-withdrawal problem handled explicitly. It is the shape most protocols
integrating v4 for yield will need.

## 4. Where the numbers come from, since that is the usual objection

The obvious criticism of a vault that lends out somebody else's escrow is that
it is a rule engine wearing a hat: a few thresholds someone picked, presented as
policy. That criticism would have been correct about our first version, and a
fuzzer is what proved it.

**Version one** deployed everything except a flat 20% buffer. It read as
prudent. It was wrong within a few thousand fuzz calls, and the reason is
embarrassing in hindsight: **milestones are not 20% of an escrow.** A 20% buffer
cannot pay a 50% milestone when the venue is down. The number was chosen by a
person and answered no question the contract could ask.

**Version two derives the reserve instead of choosing it.** The cap is the
largest claim that could arrive next, read from the escrow's own milestones —
[`AtelierYield.sol`](app/contracts/solidity/src/yield/AtelierYield.sol),
`investableCeiling`:

- An **open job** is refundable in full at any instant, so none of it is lendable
  — the ceiling is zero, not a fraction.
- Once a freelancer is hired, claims arrive **one milestone at a time**, so the
  largest unpaid milestone stays in cash. That figure is contract state, not a
  parameter.
- The percentage buffer sits *on top* of that, not instead of it.

The distinction matters more than it sounds. A threshold is an opinion about
risk; a derived reserve is an answer to "what is the worst thing that can be
asked of me next". The second one keeps holding when the escrow's shape changes,
and it is why `_rebalanceYield` runs on every obligation change rather than on a
timer.

**The invariant we could honestly keep**, after the fuzzer took the stronger one
away: *cash plus deployed capital never falls below what is owed.* A failing
venue can delay a payout; it cannot lose the money. We wanted to claim that a
failing venue could never even delay one, and that claim was false.

### Where this goes next

Worth saying plainly, because "how does this evolve" is a fair question of any
adapter:

1. **Attach it to a live pool on Arc mainnet.** The adapter is written and
   fork-proven; what is missing is a v4 deployment on the chain the escrows live
   on. `deposit()` reverts until a pool is named, deliberately.
2. **Multiple venues behind the same interface.** `IYieldAdapter` exists so the
   escrow never knows which venue it is talking to; a second adapter is a new
   file, not a new escrow.
3. **The ceiling generalises past escrow.** Any contract that owes money on a
   schedule — vesting, streaming payroll, insurance float — has a "largest
   imminent claim" and can use the same reserve rule. That is the part we think
   is reusable, more than the adapter itself.

What we are **not** doing is writing a hook. Atelier is a liquidity provider
with a known exit date, not a swap venue, and a hook here would be a buzzword
attached to a product that does not need one.

## 5. What went well

- **Stable-stable pools are the right primitive for this.** Near-zero divergence
  loss is what made it defensible to put escrowed money anywhere at all. On a
  volatile pair we would have cut the feature.
- **v4's singleton design genuinely helps a vault.** One approval target and one
  address to reason about is materially simpler to audit than v3's
  pool-per-pair.
- **Deploy addresses being deterministic across chains** made writing the
  multi-chain probe above trivial.

## 6. The thing we got wrong, and what it says about integrating

Worth recording because it is a lesson about yield integrations generally, not
about Uniswap.

Our first version deployed "everything except a 20% buffer" and claimed
*principal is redeemable at face value, instantly, always*. A fuzzer running a
deliberately hostile venue broke it in a few thousand calls: cash at 502.5
against a claim of 600. Milestones are not 20% of an escrow — a two-milestone
job has one worth half the budget, and no buffer expressed as a percentage
survives that.

The fix was to derive the cap from **the largest single claim that could arrive
next**, not from a percentage, and to rebalance every time a payout changes what
is owed. The honest invariant is weaker than the one we started with:

> Cash plus deployed capital never falls below what is owed. A failing venue can
> **delay** a payout; it cannot lose the money.

That is what the tests prove, so that is what the contract says.

**The generalisable point:** anyone routing custodial funds into an AMM will hit
this. The safe deployment level is a function of the largest imminent claim, and
it moves every time the vault pays out. We would have liked to find that in a
Uniswap integration guide rather than in a fuzzer at 2am.

---

## Environment

Solidity 0.8.20 (contract) / 0.8.28 (build), Foundry, OpenZeppelin 5.1 upgradeable,
UUPS proxy on Arc testnet. 70 contract tests, including 128,000-call fuzzed
invariants over a venue that reverts, goes illiquid, short-changes withdrawals,
and loses value.
