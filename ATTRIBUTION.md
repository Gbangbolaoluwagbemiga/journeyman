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

- _(in progress)_

## Third-party dependencies

OpenZeppelin (contracts and upgradeable), Foundry, Uniswap v4, React, Vite,
TypeScript, Tailwind, shadcn/ui, wagmi, Reown AppKit, viem, The Graph tooling,
Circle Developer-Controlled Wallets, Groq, Supabase, Playwright, Vitest. All
used as published.

## What is not claimed

No users. No traction. No revenue. The prior projects have their own histories;
this repository is a hackathon build and is described as one.
