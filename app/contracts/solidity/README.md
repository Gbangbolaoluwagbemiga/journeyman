# Atelier contracts

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
all. It currently covers the Autopilot job-manager delegation:

**47 tests, from a baseline of zero.**

| File | Tests | What it holds |
|---|--:|---|
| `JobManagerBase.t.sol` | — | Shared fixture: mock USDC, the five-party cast, proxy deployment, helpers to build a live Autopilot job |
| `JobManager.t.sol` | 20 | Appointment, revocation, the permission boundary, disputes mid-Autopilot |
| `JobManagerInvariant.t.sol` | 5 | The one-way key as a fuzzed invariant, plus liveness checks proving the handler is not inert |
| `AtelierUpgrade.t.sol` | 15 | Upgrade safety — every one against a proxy holding a live, part-paid escrow |
| `AtelierE2E.t.sol` | 7 | Whole journeys, with USDC conservation asserted at every hop |

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
forge script script/Deploy.s.sol  --rpc-url arc_testnet --broadcast
PROXY_ADDRESS=0x… forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast
```

**The proxy address is the contract.** The frontend, the agent daemon, the
subgraph and every explorer link point at the proxy and never at the
implementation, which changes on every upgrade.

### What upgradeability costs

Atelier's promise is that neither party can unilaterally move money once an
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

1. `forge test --match-path test/AtelierUpgrade.t.sol` must pass.
2. New state variables go **immediately above `__gap`**, and `__gap`'s length
   drops by the slots used. Never reorder, retype, or delete.
3. Bump `version()` in the same commit as any storage change.

A bad upgrade does not revert. It reinterprets live escrow storage under the new
layout and carries on, with wrong numbers and real money behind them.

## Deployments

| Network | Address | Notes |
|---|---|---|
| Arc EVM Testnet (`5042002`) | `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59` | **Pre-ETHOnline.** Not upgradeable, no job manager. Superseded; keeps its own escrows. |
| Arc EVM Testnet (`5042002`) | **`0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE`** | **Current.** UUPS proxy, `2.0.0-autopilot`, deployed in block `60797735`. Implementation `0x38c42aBd2C652784AE3F2100Fa34127Ad67cAc5f`. |

See `docs/adr/0001-autopilot-delegation.md`.
