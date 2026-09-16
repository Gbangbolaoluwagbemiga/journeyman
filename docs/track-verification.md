# Track verification — the three open questions, answered

> **Superseded on the eligibility question. See [`tracks.md`](tracks.md) for what
> Atelier actually submits for.**
>
> This page was written on 2026-09-06, while the project was still expected to
> enter under Continuity. That decision was reversed: Atelier is registered from
> scratch, so every Continuity-only prize is out and the From Scratch pools are
> in. The rows below that assume Continuity are wrong and are marked. Everything
> else here — what Goldsky costs us, what Arc does and does not have — was
> checked against the sponsors' own pages and still holds.

**Checked 2026-09-06** against the live ETHOnline 2026 prize page and each
sponsor's own documentation.

`ETHONLINE.md` (the campaign plan) closed with four open questions and warned
that finding the answers on Sept 10 would cost more than finding them now. Three
are answered here. **Two of them change the plan.**

The rule this is serving is the first row of BRIEF.md's do-not-repeat table:
*only claim what ships; verify against the platform's real capabilities first.*

---

## 1. The Graph — does the Continuity track accept Goldsky?

### **No. Our current provider does not qualify.**

The AI Tooling (Continuity) track, verbatim:

> "Consume live data from a Graph provider, for example querying Subgraphs with
> an API key from **Subgraph Studio**, or streaming Substreams via **The Graph
> Market**. Mocked, local-only, or static datasets do not qualify."

The two source projects both read from **Goldsky**, which is a third-party host and
is not named. On the page's own language it does not satisfy the requirement.

**But the fix is available.** Arc *is* on The Graph's supported-networks list, so
the existing subgraph can be redeployed to Subgraph Studio and queried with a
Studio API key. This is a migration, not a rewrite.

**Two things the campaign plan got wrong in our favour:**

The Graph is offering **$15,000 across three $5,000 tracks**, not one:

| Track | Prize | Fit |
|---|---|---|
| Best Use of Composable/Standardized Products | $5,000 | Not claimed — we ship one purpose-built subgraph, compose no second Graph product, and implement no standardized schema |
| **Best AI Tooling (From Scratch)** | **$5,000** | **Our target** — reversed since this was written; we are registered from scratch. The agent reads the subgraph to score applicants and release payment |
| Best AI Tooling (Continuity) | $5,000 | ~~Our target~~ — not eligible, we are not a Continuity project |

**Action:** migrate Goldsky → Subgraph Studio. This is now the highest-value
single task on the board — it is the difference between $5,000 addressable and
$0, and it also unlocks a second $5,000 track if we compose a second Graph
product.

### Update, 2026-09-06 — migration prepared

The docs page lists only mainnets, which briefly looked like it meant Arc testnet
was unsupported and the Graph track depended on the Arc mainnet deploy. It does
not. The Graph's own networks registry is definitive:

```
id: arc          | Arc Mainnet | eip155:5042    | services: ['subgraphs']
id: arc-testnet  | Arc Testnet | eip155:5042002 | services: ['subgraphs']
```

`arc-testnet` matches our chain exactly, so the manifest's existing
`network: arc-testnet` is already correct and this is a redeploy rather than a
chain move. Subgraph builds clean against Studio, now also indexing the Autopilot
delegation. **Remaining: a Studio account and deploy key** — see
`subgraph/README.md`.

---

## 2. World — is there a Selfie Check track, and what does it need?

### **Yes. Confirmed, and it fits the reputation work.**

> "Uses Selfie Check or a Selfie Check-compatible World ID credential flow in a
> meaningful way" for "risk, eligibility, fairness, continuity, or
> abuse-prevention."

That is close to a description of Pillar 1: reputation is farmable today because
`submitRating` trusts any address, and Selfie Check gates *reputation
eligibility* rather than platform access. The framing the plan already chose —
abuse-prevention and fairness — is the sponsor's own language.

**Correction to the numbers:** the $3,500 is a **pool split across up to three
teams at $1,166 each**, not a single award. The same is true of most tracks on
this page.

---

## 3. Chainlink — is VRF eligible, and does it work on Arc?

### **Eligible: yes. Usable on Arc: no.**

The Powered Upgrade (Continuity) track, $500, lists eligible products as:

> "Chainlink Runtime Environment (CRE) — including Confidential Workflows, Price
> Feeds, Data Streams, Proof of Reserve (PoR), **VRF (Verifiable Random
> Function)**"

with the requirement that "the Chainlink integration must contribute to a state
change on a blockchain." Random arbiter selection would satisfy that.

**The blocker is the chain.** Chainlink's VRF v2.5 supported-networks page lists
nine ecosystems — Arbitrum, Avalanche, BASE, BNB, Ethereum, Optimism, Polygon,
Ronin, Soneium. **Arc is not among them.** VRF cannot be called from the contract
our escrows actually live in.

**Recommendation: cut it, or defer it below everything else.** Making it work
means deploying a second copy of the escrow on Base or Ethereum Sepolia purely so
one $500 track has somewhere to run, on a chain where none of our users, funds,
or subgraph are. That is a bolt-on chasing a track — the second row of the
do-not-repeat table — and it costs a day we owe The Graph migration.

*(Note on method: two passes over the prize page disagreed about whether VRF was
listed. The verbatim-quote pass above is the one to trust; the first pass
summarised and dropped it. Worth re-reading the page directly before acting on
anything here.)*

---

## 4. Still open — 1inch Aqua/SwapVM as the yield venue

Not investigated yet. Lower priority: it is a Tier-3 "could convert to Tier 1"
question, and it does not gate any work currently scheduled.

---

## What this changes

| Was | Now |
|---|---|
| Graph track worth $5,000, Goldsky assumed fine | **$15,000 across three tracks, and Goldsky disqualifies us.** Migration to Subgraph Studio is the top task |
| Chainlink VRF arbiter, Sept 10, $500 | **Cannot run on Arc.** Cut or defer |
| "~$19.7k addressable" | Optimistic — most prizes are pools split up to three ways. Same tracks, smaller realistic take |

Uniswap is also larger than planned: $3,000 open plus $2,000 Continuity, and
`FEEDBACK.md` is named in the requirements rather than being our own good idea.

Every Continuity track additionally requires a README that **separates
pre-existing from new work**, and a demo video focused on the new work.
`ATTRIBUTION.md` covers the first; the video does not exist yet.

## Sources

- [ETHOnline 2026 prizes](https://ethglobal.com/events/ethonline2026/prizes)
- [Chainlink VRF v2.5 supported networks](https://docs.chain.link/vrf/v2-5/supported-networks)
- [The Graph supported networks](https://thegraph.com/docs/en/supported-networks/)


---

## Round two, 2026-09-06 — the sponsor list was wider than we thought

The first pass read a search snippet listing eight sponsors. The prize page
itself lists **eleven**, and two of the missing ones matter:

| | Campaign plan assumed | Actually |
|---|---|---|
| **Arc** | ~$3.1k across two tracks | **$10,000** across several |
| **Bazantic** | $1.5k | **$3,000** across four tracks |
| **Privy** | listed Tier 2 | confirmed, 2 × $2,500 |

Arc being $10k rather than $3.1k changes the ordering: it is the chain Atelier
already lives on, the integration is already done, and the remaining work is a
mainnet deploy that has a deadline of Sept 30 rather than Sept 16.

**Lesson, again:** read the sponsor's own page, not a summary of it. This is the
second time a summarised source was wrong in a way that would have cost real
work — the first was VRF.

## Uniswap — verified, and it constrained the build

The track is broad: "the Uniswap API, the Uniswap AMM (v2, v3, or v4), CCA, or
any other Uniswap protocol." Hooks are not required.

**But v4 is not on Arc testnet.** Probed directly rather than trusted:

```
cast code 0x8366a39cc670b4001a1121b8f6a443a643e40951 --rpc-url <arc-testnet>
0x
```

It is on Arc **mainnet** (opens Sept 16) and on Ethereum, Base and Unichain
Sepolia. So the escrow-side yield layer is built and fuzz-tested against a
hostile venue on Arc, and the v4 adapter is written but deliberately fails
closed until it is proven against a live PoolManager.

`FEEDBACK.md` — required for the track — is written and covers this, the
v4-core dependency weight, and the missing custodial-vault example.

---

## Strategy reset, 2026-09-06 evening

Two facts from the submission form change everything above.

**1. A maximum of three partners may be applied to.** Not ten. The portfolio
approach the campaign plan was built on — spread across ten tracks for ~$19.7k
addressable — is not a thing that can be submitted. Three is the number.

**2. We are entering as a new project, not on Continuity.** The reasoning is
the entrant's own and it is sound: Continuity puts Atelier beside projects that
arrive with real users and real volume, and Atelier has neither. It is a week
old. Competing on "what did you build this week" is a fair fight; competing on
traction is not one we can win.

So `BASELINE.md` is gone and `ATTRIBUTION.md` replaces it. The difference
matters: the baseline existed to prove which code predated the event, which is
the question Continuity asks. Attribution answers the question a from-scratch
entry is asked instead — what is this built on — and answers it honestly, naming
our own prior open-source work as the boilerplate it is.

### The three

| Partner | Prize | Why |
|---|---|---|
| **The Graph** | $15,000 | Largest pool. The agent polls the subgraph to hire, score and pay — load-bearing, not decorative. Blocked only on a Studio key. |
| **Arc** | $10,000 | Atelier is an Arc application: USDC-native, deployed, upgradeable, agentic. Mainnet opens Sept 16 with a Sept 30 deadline. |
| **Uniswap** | $5,000 | Productive escrow, fuzz-tested, with a `FEEDBACK.md` that names three real integration frictions. |

Not applying to: World, Privy, Ledger, Chainlink, 1inch, ENS, Hedera, Bazantic.
Bazantic is the closest call — its recipe is written and it needs only an
account — but three is three, and $3,000 does not displace any of the above.
