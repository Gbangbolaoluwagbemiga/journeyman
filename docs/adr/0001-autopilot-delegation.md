# ADR 0001 — Autopilot needs a scoped job manager on-chain

**Status:** implemented, tested, **deployed**
**Date:** 2026-09-05 · implemented 2026-09-06 · deployed 2026-09-06

> **Live on Arc testnet.**
>
> | | |
> |---|---|
> | Proxy (this is the contract) | `0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE` |
> | Implementation | `0x38c42aBd2C652784AE3F2100Fa34127Ad67cAc5f` |
> | `version()` | `2.0.0-autopilot` |
> | Deploy block | `60797735` |
>
> The pre-existing `0x6142…ab59` is superseded and keeps its own escrows; it is
> not upgradeable and has no job manager.
>
> There is a second, abandoned proxy at `0x370e…0C11` from earlier the same day.
> It is identical code and it worked — the live delegation was first proved on
> it — but it carries a cancelled smoke-test escrow, so `nextEscrowId` starts at
> 2 there. Atelier runs on a contract with no history at all rather than one
> whose first job is a test, and the redeploy cost about \$0.30 of faucet gas.
> Nothing points at `0x370e…0C11` any more.
>
> The in-source markers in `PostJobPage.tsx` and `AutopilotComposePage.tsx` have
> been resolved, because the mechanism they were hedging now exists on-chain.
> What has NOT changed is the trust story: the contract cannot take a client's
> money, and the proxy owner can replace the implementation. Both clauses belong
> in the submission.

## The claim we want to make

Atelier's middle row — a human client, managed by Autopilot — is only worth
anything if this sentence is true:

> The agent can pay the freelancer. It can never pay itself, move your money
> anywhere else, or settle a dispute. Escrow and dispute rights stay yours.

`PostJobPage` says exactly this to the client at the moment they choose the
mode. It is the reason handing a job to an agent is a reasonable thing to do
rather than a leap of faith.

**It is not true today.** This ADR records why, and what has to be built.

## Why it is not true today

Every management function on the deployed contract checks the depositor:

```solidity
// SecureFlow.sol  — pre-rename; this file is now src/Atelier.sol
function approveMilestone(uint256 escrowId, uint256 milestoneIndex) external … {
    Escrow storage esc = _requireEscrow(escrowId);
    if (esc.depositor != msg.sender) revert Unauthorized();
```

`rejectMilestone` and `acceptFreelancer` carry the same check. So an agent
cannot manage an escrow that a client funded — there is no seat at the table
for a third party.

Atelier works around this by **being the depositor itself.** When a human
commissions Atelier today (`POST /api/instruct`), they deposit into Atelier's
shared treasury, and `createEscrow` is then called with Atelier's own Circle
Agent Wallet as the signer:

```ts
// agent/daemon/src/web3/secureflow.ts  — pre-rename; now web3/atelier.ts
account: signer.address,   // Atelier's wallet — not the human's
```

The human's position is a row in Atelier's SQLite ledger. On-chain they are
nobody. Concretely, a human client of Atelier today:

- is **not** the escrow depositor
- **cannot** approve or reject a milestone
- **cannot** raise a dispute — `disputeMilestone` admitted only the depositor
  and the beneficiary when this was written; see the amendment below
- **cannot** cancel, extend, or reclaim after the deadline
- relies on Atelier's honesty and uptime for the return of unspent funds

That is a custodial arrangement. It is fine for what Atelier was — an agent
spending *its own* money — and it is not fine as the basis for asking a
stranger to hand over management of *their* money.

**This gap is the single most valuable thing to fix in the merge**, because it
is the difference between the middle row existing and merely appearing to.

## Decision

Add a **scoped job manager** to the escrow contract.

```solidity
mapping(uint256 => address) public jobManager;

function setJobManager(uint256 escrowId, address manager) external;   // depositor only
function revokeJobManager(uint256 escrowId) external;                  // depositor only
```

A manager may do the *labour* of managing, and nothing else:

| Function | Depositor | Manager |
|---|:--:|:--:|
| `acceptFreelancer` | ✅ | ✅ |
| `submitMilestone` (freelancer) | — | — |
| `approveMilestone` | ✅ | ✅ |
| `rejectMilestone` | ✅ | ✅ |
| `disputeMilestone` | ✅ | ✅ — see amendment |
| `cancelJob` | ✅ | ❌ |
| `withdrawJobFunds` / `addJobFunds` | ✅ | ❌ |
| `extendDeadline` | ✅ | ❌ |
| `emergencyRefundAfterDeadline` | ✅ | ❌ |
| `setJobManager` / `revokeJobManager` | ✅ | ❌ |

### The one-way key, stated as an invariant

> **No action by a manager can cause value to reach the manager.**

Approval pays `esc.beneficiary` and nothing else, so a manager that approves is
paying the freelancer by construction. The attack this leaves open is the
manager hiring *itself* (or a confederate) as the freelancer and then approving
its own work — so the guard is not optional:

- `setJobManager` reverts if `manager == esc.beneficiary`
- `acceptFreelancer` reverts if the caller is the manager and
  `freelancer == msg.sender`
- while a manager is set, `acceptFreelancer` reverts if
  `freelancer == jobManager[escrowId]`, whoever calls it

Collusion with an unrelated address remains possible and is **not** solvable in
the contract — it is bounded instead by the client keeping dispute rights, the
ability to revoke the manager at any moment, and per-job escrow amounts. Say
this plainly in the submission rather than implying the contract prevents it.

### Tests this needs before the claim goes back in the UI

All seven exist and pass — see `contracts/solidity/test/`. Written against the
case we did *not* design for, per BRIEF.md:

1. Manager cannot approve into its own address, by any path
2. Manager cannot become the beneficiary — direct, or via `acceptFreelancer`
3. Manager cannot cancel, extend, or withdraw; it may escalate and gains nothing by it
4. Revocation is immediate: a revoked manager's next call reverts
5. Depositor retains every one of its powers while a manager is set
6. A dispute mid-Autopilot resolves normally and pays out from reserve
7. Fuzz: for random action sequences by a manager, the manager's balance
   never increases

## Consequences

- **A new contract deployment.** The deployed `0x6142…ab59` cannot gain this;
  Arc mainnet is already on the schedule for Sept 14, so this rides along.
- **Atelier's daemon changes shape** for human-commissioned jobs: it stops being
  the depositor and starts being the manager of an escrow the client funded.
  Its agent-commissioned path (`/api/hire`, x402) is unaffected — there, Atelier
  genuinely is the client and should be the depositor.
- **The `verified`/reputation work stacks on top**, because the manager is now
  a distinct on-chain role that can carry its own record.
- Until it ships, `PostJobPage`'s guarantee paragraph is marked in-source as
  not-yet-true and must not be deployed.

## Alternatives rejected

**EIP-2771 meta-transactions** (already in the codebase for gasless applies):
the client signs, the relayer submits. Rejected because it needs the client
present to sign each approval, which is precisely the labour Autopilot is
supposed to remove. It solves gas, not delegation.

**Keep Atelier as depositor, add an off-chain promise.** Rejected: it is the
current arrangement, and no amount of UI can make a SQLite row into an escrow.

**A generic account-abstraction session key.** Stronger in the abstract, but it
delegates *transaction signing* rather than *a role*, so the one-way-key
invariant would live in policy configuration instead of in the contract, and
could not be unit-tested as a property of the escrow. A narrow, auditable
per-escrow role is the smaller and more defensible surface.


---

## Implementation notes (2026-09-06)

**What was built.** `jobManager` mapping, `setJobManager` / `revokeJobManager` /
`isJobManager`, and an `_onlyDepositorOrManager` check replacing the bare
depositor test on exactly three functions: `acceptFreelancer`,
`approveMilestone`, `rejectMilestone`. Nothing else moved.

**The one-way key needed two enforcement points, not one.** `setJobManager`
checks `manager != beneficiary`, but on an open job the beneficiary does not
exist yet — it is assigned by `acceptFreelancer`. So the self-hire guard lives
there too, and is checked against the *stored* manager rather than `msg.sender`,
which also stops a depositor from hiring their own agent as the worker by
mistake.

**Milestone proposals were deliberately left out.** `approveMilestoneProposal`
and `rejectMilestoneProposal` change a milestone's amount, and while that still
only ever pays the beneficiary, it is a money decision rather than review
labour. Depositor-only for now. Revisit only if Autopilot demonstrably needs it.

**One test expectation was wrong and the contract was right.** A manager
approving a disputed milestone reverts with `EscrowNotActive`, not
`MilestoneNotSubmitted` — a dispute freezes the whole escrow, not just the
milestone under argument. That is the stronger guarantee, and the test now pins
it deliberately.

**The invariant handler includes the calls a manager must NOT have** — dispute,
cancel, withdraw, extend, re-appoint, self-hire. A handler offering only the
permitted calls would prove nothing; this one would find the path if a guard
were ever loosened. Two liveness tests assert the handler actually moves money,
because every handler call is wrapped in try/catch and a fully-reverting handler
would report 128,000 calls, zero reverts, and three green invariants while
testing nothing.

**Still to do before the UI may claim this:** redeploy (rides along with the
Sept 14 Arc mainnet push), then wire `setJobManager` into Atelier's Autopilot
job creation, then delete the in-source `NOT TRUE YET` marker in
`PostJobPage.tsx` and the custody notice in `AutopilotComposePage.tsx`.

---

## Amendment — the manager may escalate (3.3.0)

The original decision denied `disputeMilestone` to the manager, and listed the
client keeping dispute rights as one of the bounds on manager–freelancer
collusion. Denying it turned out to strand jobs.

On a job the client funds themselves — which is now the normal Autopilot path,
not the custodial one this ADR was written against — the agent is the manager
and not the depositor. So when its revision rounds ran out, its escalation
reverted `Unauthorized` and the job stopped there: nobody paid, nothing
refunded, no arbiter. The agent's only remaining moves were to approve work it
had already judged inadequate, or to reject it forever. Both are worse for the
client than handing the decision to a person.

**What this does not change.** Escalation hands the decision away rather than
taking it: an arbiter may award only the freelancer or the client, and the
manager is neither. The one-way key is intact, and the fuzz invariant — which
already had the manager attempting `disputeMilestone` among its random actions —
still holds that a manager's balance never rises.

**What it costs.** A malicious manager can freeze a job by escalating it. That
is bounded the same way every other manager power is: the client can revoke at
any moment, escrow is per-job, and the frozen funds go to an arbiter rather than
anywhere near the manager. Weighed against a guaranteed stuck job on every
client-funded Autopilot escrow that exhausts its revisions, the trade is worth
making — and it is the client's own agent, appointed by them, in either case.

The client keeps dispute rights exactly as before. This adds a second party who
may escalate; it removes nothing.
