# Atelier — ETHOnline 2026 Build Brief

> **This is the original plan, kept for the record. Where it disagrees with what
> shipped, what shipped wins.**
>
> It was written before the build, describes a two-repository workspace that no
> longer exists, and names directories (`secureflow/`, `patron/`) that were
> merged into this one. It is still here because two ADRs cite its reasoning,
> and because a plan that was wrong in places is more honest to keep than to
> quietly delete.
>
> For what Atelier actually submits for, and the file and line behind every
> claim, read [`docs/tracks.md`](docs/tracks.md). For what it is built on, read
> [`ATTRIBUTION.md`](ATTRIBUTION.md).

**Read this entire file before writing any code.** This workspace is a fresh build that merges two
existing, live products into one. Both are already here — read them before changing anything.

---

## Stakes

ETHGlobal **ETHOnline 2026**, Sept 4 → 16 (async).

**Superseded: Atelier is entered from scratch, not on the Continuity track.** This
paragraph originally said the opposite, and leaving it would have had the repo
claiming both at once. Every Continuity-only prize is marked ineligible rather
than claimed — see [`docs/tracks.md`](docs/tracks.md). Atelier is a new product
built during the event on our own prior open-source code, which
[`ATTRIBUTION.md`](ATTRIBUTION.md) names in full.

Targeting ~$19.7k across 10 sponsor tracks. Full portfolio, pillar breakdown and cut lines live in
`../../Arc/Secureflow/SecureFlow-scaffold/ETHONLINE.md` — that is the campaign plan; this file is
the build spec. They must not contradict each other; if they do, the campaign plan wins.

The builder is solo, has shipped both source products, and has a track record worth protecting
(Scaffold Stellar Hackathon 2025 winner, live on Arc and Stellar, Giveth-listed). This is not a
first attempt at anything.

---

## What we are building

**The product is Atelier. SecureFlow is the protocol underneath it.**

An atelier is a workshop where skilled people make things by hand — and historically, an atelier is
what a *patron* funded. The lineage from Patron is direct without reusing the name, and it points at
human craft, which is the entire differentiator against machine services.

The sentence to say to a judge:

> **Atelier is where AI agents hire people. SecureFlow is the escrow protocol underneath it.**

Building under a separate name is deliberate: it insulates everything already live — the Arc
deployment, real users, the Giveth listing, grant applications — from anything experimental here.
If this lands, it gets absorbed into SecureFlow. If it doesn't, SecureFlow never wobbled.

Patron does not survive as a separate brand. Its agent becomes **Autopilot**, a mode inside Atelier.

### The core model — get this right or nothing else matters

**The freelancer is always a human.** That is the entire product. There is no version where a
machine does the work. What varies is who the *client* is, and who does the work of *managing* a job.

| Client | Managed by | What it is |
|---|---|---|
| Human | Themselves | SecureFlow as it works today |
| **Human** | **Autopilot** | **NEW** — post "logo, $50, 3 days"; the agent briefs, hires, reviews, pays |
| AI agent | Autopilot | Patron as it works today — agent pays via x402, agent manages |

The middle row is the genuinely new surface. Neither source product does it. A human client
delegates the *labour of managing* — writing the brief, scoring twenty applicants, reviewing the
delivery — while still holding escrow, still able to dispute, still protected by the one-way key.

Pitch line: **Real people, paid in USDC — whether the client is a person or an AI.**

### Information architecture

One app. The freelancer experience is singular; only the client area has modes.

```
Atelier
├── Browse Jobs     ← ONE list. Agent-posted and human-posted, mixed, indistinguishable.
├── My Work         ← freelancer: applications, active jobs, earnings
├── Post a Job      ← choose mode: Manual | Autopilot
├── My Jobs         ← manual    → milestone review UI
│                     autopilot → live decision log + agent activity feed
├── Analytics
└── Disputes / Arbiter
```

A freelancer must not be able to tell whether their client is a person or an agent. This is already
true on-chain — both emit identical `applyToJob` transactions to the same subgraph. Do not add a
UI that breaks it.

---

## The two source projects (both in this workspace)

### `secureflow/` — the base. Build here.

Live escrow protocol + dApp on Arc testnet. Contract `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59`,
chain ID 5042002. React + Vite + TypeScript, Tailwind + shadcn/ui, wagmi + Reown AppKit. Express
backend (`backend/`) with Groq-powered AI writers. Goldsky subgraph + RPC multicall fallback.
Vitest suites in `test/` and `backend/test/`.

**This is the base for the unified app** — more UI surface, an extensible component system, and it
owns the contracts.

### `patron/` — the source to merge FROM. Do not deploy separately.

AI agent that hires and pays humans, built ON SecureFlow's contracts. Node daemon (`daemon/`,
raw `node:http`), Circle Agent Wallets (MPC), x402 both directions, Gateway, SQLite + SSE, Telegram
bot, subgraph poller. Its own React command center in `web/`.

**Take from Patron:** the guild-master brain (`daemon/src/agent/` — BriefGenerator, ApplicationScorer,
WorkReviewer), the managed-wallet layer (`daemon/src/workers/`), the x402 seller/buyer plumbing
(`daemon/src/circle/`), and the visual language of `web/` (see Design below).

**Patron's daemon stays a service.** Do NOT rewrite it into the Express backend. It runs 24/7, holds
keys server-side, and works. The new frontend talks to both backends.

---

## Design

Base on **SecureFlow's system** — dark glass, teal/navy, Tailwind + shadcn. More surface area,
faster to extend.

Borrow from **Patron**: the amber accent, a serif for big moments (Fraunces), the "one enormous
number" treatment on money paid to humans, and the marginalia layout for the decision log. Patron's
Ledger is the best-looking screen either project has — that energy must survive the merge.

### The rule that makes the blend mean something

> **Teal = a human did this. Amber = the agent did this.**

Every decision, approval, payment and review carries the colour of whoever made it. An Autopilot job
reads amber all the way down until an arbiter steps in, and it turns teal. This converts "blend two
palettes" from a cosmetic problem into a legible visual language, and shows the human/agent boundary
in three seconds without narration.

The UI bar is non-negotiable: both source products have polished, distinct identities. The merged
product must not look like a worse version of either.

---

## Compliance — disqualification risks, handle on day one

- [ ] **Register as a Continuity project** with ETHGlobal
- [ ] **Disclose pre-existing work in writing** — explicit rule, not optional
- [ ] `BASELINE.md` — exactly what existed before Sept 4, with source commit hashes for both repos
- [ ] **Commit continuously.** ETHGlobal: *"repositories with single commits of large files without
      proper history will be default assumed to be unqualified."* Never squash the whole build into
      one commit. Frequent, honestly-described commits.
- [ ] Submission must separate existing vs new work in the repo, the video, and the description
- [ ] `FEEDBACK.md` + Uniswap Developer Feedback Form (required for that track)
- [ ] World: feedback doc covering docs, integration flow, Sandbox states, testing experience
- [ ] Per-track demo videos within each track's stated time limit

**Secrets:** no `.env` was copied into this workspace. Copy your own from the source projects before
running anything, and confirm `.gitignore` excludes them before the first push.

---

## Do not repeat — lessons already paid for

| Mistake | Rule |
|---|---|
| Claiming a mechanism that the platform cannot actually do (Antibody's "randomized delay") | Only claim what ships. Verify against the platform's real capabilities first. |
| Bolting on a buzzword to chase a track | Every integration attaches to a product pillar or it gets cut. Judges score coherence. |
| Hardcoding a vendor model name (Groq decommission broke prod twice) | Model IDs come from env with a sane default — Patron already does this correctly in `daemon/src/config.ts`; SecureFlow does not. Fix during the merge. |
| Tests that only covered constructed cases (Antibody's block-advancing helpers) | Test the case you did NOT design for. Especially the yield invariant. |
| Quietly patching a discovered flaw | Document what went wrong and what changed. The honesty has consistently scored well — it is an asset, not a liability. |
| Overclaiming traction | Every number stated must be readable off-chain or off the subgraph. |

---

## The riskiest feature: productive escrow

**Invariant, non-negotiable: principal is redeemable at face value, instantly, always.** Yield is
upside; it is never a risk to money that isn't ours.

- Only **idle** capital deploys: escrow funded, milestone not due, client **opted in**
- **~20% buffer** never invested
- **Stable-stable only** (USDC/USDT). No volatile pairs, ever.
- Withdrawal: buffer → unwind → **circuit breaker**. If unwind fails or slips past tolerance, the
  escrow still resolves from reserve. **A yield failure must never block a payout or a dispute.**
- Fuzz the invariant across every state: mid-dispute, mid-unwind, buffer exhausted.

If the invariant test cannot be written, ship the feature opt-in and capped rather than unbounded.

---

## How to proceed

1. Read this file, then `../../Arc/Secureflow/SecureFlow-scaffold/ETHONLINE.md` for the track plan.
2. Read both source projects' READMEs before touching code.
3. **Day one is compliance**, not code: `BASELINE.md`, Continuity registration, `pre-ethonline` tag.
4. Then the unified app shell — modes, shared freelancer view, Autopilot job view, design tokens.
5. Features in the campaign plan's order. Commit continuously and honestly throughout.
