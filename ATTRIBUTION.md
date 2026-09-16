# Attribution

**Journeyman is built for the Arbitrum Open House Singapore Buildathon, on top
of our own prior open-source work.** The buildathon invites you to "bring an
existing project or start from scratch"; this is the first of those, and this
file is the honest accounting of which parts are which.

The commit history is the evidence. The first commit is the inherited source,
labelled as such, and everything after it was written for this event.

---

## The lineage, in order

**SecureFlow** — a milestone escrow protocol. A human client funds a job, a
human freelancer delivers it, payment releases per milestone, an arbiter settles
disputes. Deployed on Arc.

**Patron** — an agent that commissions work: it writes the brief, scores
applicants, reviews what comes back, and pays over x402. Shortlisted at the
Encode x Arc hackathon.

**Atelier** — the merge of the two, built for ETHGlobal ETHOnline 2026. Neither
source project could do the thing in between: a human client who delegates the
*managing* of a job — the brief, the shortlist, the reviews — to an agent, while
keeping the money. Atelier added the on-chain job-manager role that makes that
safe, the managed-wallet front door, and productive escrow.

**Journeyman** — this repository. Atelier ported to Arbitrum, with the parts
that Arc could not run finally running.

A journeyman is a skilled worker who has finished an apprenticeship and hires
out by the job. The word comes from the French *journée*, a day's work paid
daily — which is what milestone escrow is.

## What is inherited

Everything in the first commit: the escrow contract and its tests, the agent
daemon, the React application, the Express service, and the subgraph.

## What is new, and written for this event

Recorded here as it lands, rather than claimed in advance.

- **The Arbitrum port.** `evm_version` from shanghai to cancun, which is the
  reason for the move: Arc EVM is not guaranteed to have TSTORE, and Uniswap
  v4's PoolManager takes its lock with it, so the yield adapter could be
  fork-tested there and never deployed. It compiles for deployment here.
- **Deployed and verified on Arbitrum Sepolia.** Proxy
  `0x5128B3E2a20d483f68834b26505aFD7457C282dc`, implementation
  `0x77123D946B89Fa1367ff3f323a5c6E5A3ADB70db`, `4.0.0-journeyman-arbitrum`.
- **The two-endpoint RPC split, deleted.** Arc needed one endpoint for reads and
  another for logs because each broke differently; Arbitrum's serves both.
- **The native-currency decimal compensation, deleted.** Arc's native currency
  was called USDC and carried 18 decimals while its ERC-20 USDC carried 6, so
  the code divided by 1e18 by hand. Here they are genuinely different assets.
- **A build that works from a clean clone**, which the inherited one did not.

## Third-party dependencies

OpenZeppelin (contracts and upgradeable), Foundry, Uniswap v4, React, Vite,
TypeScript, Tailwind, shadcn/ui, wagmi, Reown AppKit, viem, The Graph tooling,
Circle Developer-Controlled Wallets, Groq, Supabase, Playwright, Vitest. All
used as published.

## What is not claimed

No users. No traction. No revenue. The prior projects have their own histories;
this repository is a hackathon build and is described as one.
