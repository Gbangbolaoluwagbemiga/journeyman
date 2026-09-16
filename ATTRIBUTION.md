# Attribution

**Atelier is a new product, built for ETHOnline 2026.** It is not a rebrand of
anything, it has no users, and it makes no claim to traction. This file records
what it is built on, because "from scratch" does not mean "from nothing" and
pretending otherwise would be the one dishonest thing in the repo.

ETHGlobal's rule is that a project "may not add features to existing work but
can use boilerplate code." What follows is our boilerplate, named.

---

## Our own open-source code, used as boilerplate

We wrote and open-sourced two projects before this event, and Atelier starts
from parts of both. They are ours, Apache/MIT licensed, and public:

| Component | Used for |
|---|---|
| An escrow contract | The milestone escrow primitive — deposit, submit, approve, dispute, arbitrate. Atelier's `Atelier.sol` starts here. |
| A React + Vite dApp scaffold | Wallet connection, contract bindings, the shadcn/Tailwind component layer, and the escrow screens. |
| An Express service | AI text helpers, the EIP-2771 relayer, Supabase upload/messaging. |
| An agent daemon | The LLM brief/score/review loop, Circle Agent Wallet integration, x402 plumbing, and the Telegram worker bot. |

Neither prior project did what Atelier does. Neither had a human client
delegating job management to an agent, an on-chain manager role, productive
escrow, or one marketplace where agent-posted and human-posted work sit
together.

## What is new, and was written during this event

- **The Autopilot delegation** — a scoped on-chain job-manager role that may
  hire, approve and reject and can never pay itself. New contract code, new
  invariant, 70 contract tests where there were none.
- **Productive escrow** — idle escrow capital deployed to a Uniswap v4
  stable-stable position, with a cap derived from the largest imminent claim and
  a fuzzed solvency invariant.
- **Atelier the product** — the unified information architecture, the Manual /
  Autopilot fork, the brief-preview flow, the decision log, the teal/amber actor
  semantic, and the merged client dashboard.
- **The managed-worker front door in the app** — signing up with a name, a
  Circle MPC wallet provisioned behind it, applying with no gas and no
  signature.
- **The upgradeable deployment** — UUPS proxy, storage discipline, upgrade
  safety tests.

## Third-party dependencies

OpenZeppelin (contracts and upgradeable), Foundry, React, Vite, TypeScript,
Tailwind, shadcn/ui, wagmi, Reown AppKit, viem, The Graph tooling, Circle
Developer-Controlled Wallets, Groq, Supabase, Playwright, Vitest. All used as
published.

## The honest summary

Atelier is a new product assembled during ETHOnline 2026 from our own prior
open-source work plus a large amount of code written this week. The commit
history is the evidence: `git log` shows it accumulating day by day, and the
first commit is the boilerplate import, clearly labelled as such.

We are not claiming users, revenue, or traction. There are none.
