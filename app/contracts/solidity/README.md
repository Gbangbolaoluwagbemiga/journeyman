# Journeyman contracts

Solidity 0.8.20 · Foundry · OpenZeppelin 5.

## Setup

`forge-std` is vendored. OpenZeppelin is not — it is declared as a submodule in
`.gitmodules`, so fetch it once before building:

```bash
git clone --depth 1 --branch v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts \
  lib/openzeppelin-contracts
git clone --depth 1 --branch v5.1.0 \
  https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable \
  lib/openzeppelin-contracts-upgradeable
```

Then:

```bash
forge build
forge test
```

## Tests

`test/` was added during ETHOnline 2026 — the baseline had no Solidity tests at
all, and it has grown with every feature since.

**186 tests, from a baseline of zero**, plus 11 more that only run against a
fork of the chain this is deployed on:

```bash
forge test --match-path test/UniswapV4Fork.t.sol \
  --fork-url https://sepolia-rollup.arbitrum.io/rpc
```

| File | Tests | What it holds |
|---|--:|---|
| `JobManagerBase.t.sol` | — | Shared fixture: mock USDC, the five-party cast, proxy deployment, helpers to build a live Autopilot job |
| `JobManager.t.sol` | 20 | Appointment, revocation, the permission boundary, disputes mid-Autopilot |
| `JobManagerInvariant.t.sol` | 5 | The one-way key as a fuzzed invariant, plus liveness checks proving the handler is not inert |
| `JourneymanUpgrade.t.sol` | 15 | Upgrade safety — every one against a proxy holding a live, part-paid escrow |
| `JourneymanE2E.t.sol` | 7 | Whole journeys, with USDC conservation asserted at every hop |

The invariant that matters:

> **No sequence of actions available to a manager can cause value to reach the
> manager.**

Run it alone:

```bash
forge test --match-contract JobManagerInvariantTest -vv
```

## Upgradeability

The contract sits behind an **ERC1967 proxy (UUPS)** so new features ship
without migrating live escrows.

```bash
forge script script/Deploy.s.sol  --rpc-url arbitrum_sepolia --broadcast --verify
PROXY_ADDRESS=0x… forge script script/Upgrade.s.sol --rpc-url arbitrum_sepolia --broadcast --verify
```

**The proxy address is the contract.** The frontend, the agent daemon, the
subgraph and every explorer link point at the proxy and never at the
implementation, which changes on every upgrade.

### What upgradeability costs

Journeyman's promise is that neither party can unilaterally move money once an
escrow is live. Upgradeability puts one asterisk on it: **the owner can replace
the implementation**, and a malicious replacement could do anything to funds
already locked.

The honest sentence is *"the contract cannot take your money, and the owner can
change the contract."* Do not describe this deployment as trustless without the
second clause. Mitigations in place: `Ownable2Step` so a mistyped ownership
transfer cannot hand over the upgrade key, `_disableInitializers()` on the
implementation, and `version()` so the running build is identifiable from chain
state alone.

### Before any upgrade

1. `forge test --match-path test/JourneymanUpgrade.t.sol` must pass.
2. New state variables go **immediately above `__gap`**, and `__gap`'s length
   drops by the slots used. Never reorder, retype, or delete.
3. Bump `version()` in the same commit as any storage change.

A bad upgrade does not revert. It reinterprets live escrow storage under the new
layout and carries on, with wrong numbers and real money behind them.

## Deployments

| Contract | Address | Notes |
|---|---|---|
| Journeyman (proxy) | **`0x5128B3E2a20d483f68834b26505aFD7457C282dc`** | **The contract.** UUPS, `4.0.1-journeyman-arbitrum`, deployed in block `309527684`. Implementation `0x1173Bcc9183f29aFbB6f4C7E3c0b25476D3daF0F`. |
| JourneymanYield | `0x44a4a235DEb0b32929DDA386E9FE931Dd055d0E3` | Yield controller. Not upgradeable — replacing it while capital is deployed strands that capital, which is why the deploy script refuses to. |
| UniswapV4StableAdapter | `0xcc116FaD144FFAC4AdD5f97820Cd4C286488e24a` | The venue. USDT/USDC, fee 100, tickSpacing 1, no hooks, against the real PoolManager at `0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317`. |

All on **Arbitrum Sepolia (`421614`)** and verified on Arbiscan. Earlier
deployments on Arc EVM belong to [Atelier](../../../ATTRIBUTION.md) and keep
their own escrows; nothing here points at them.

See `docs/adr/0001-autopilot-delegation.md`.
