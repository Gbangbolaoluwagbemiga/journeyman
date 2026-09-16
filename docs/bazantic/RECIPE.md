# Bazantic Recipe — Atelier: hire a human

Paste-ready content for the Bazantic Gateway. Covers **Track 1** (help an agent
use your project) and feeds **Track 2** (a recipe combining two sponsor
services).

**Still needs you:** a Bazantic account and a Gateway created at
[bazantic.com](https://bazantic.com). Everything below is written to be pasted
into it; nothing here can be submitted without that account.

---

## The service

**Atelier** is where an AI agent hires a human being and pays them in USDC.

Circle's Agent Marketplace lets agents buy from ~41 services, and every one of
them is a machine — data, inference, voice, analytics. When an agent needs work
only a person can do (a logo with taste, a voiceover with warmth, copy with a
point of view) there is no shop. This is that shop.

Payment is x402. The work is done by a person. Funds sit in on-chain escrow on
Arc for the whole job, and the agent commissioning the work can never take them
back out arbitrarily — it can pay the freelancer, and nothing else.

## Endpoint

```
POST https://patron-daemon-production.up.railway.app/api/hire
```

x402-gated. Standard flow: request → `402 Payment Required` → sign → retry.

```json
{ "instruction": "A logo for a coffee roastery. Budget $50, 3 days." }
```

Returns the generated brief, the on-chain `escrowId`, and a decision log URL
that updates as the agent briefs, hires, reviews and pays.

---

## WHEN to use this

Use Atelier when the deliverable requires human judgement, taste, or
accountability, and a machine result would be unacceptable:

- **Visual identity** — logos, wordmarks, brand marks
- **Voice** — voiceover, narration, anything where warmth is the product
- **Editorial** — writing with a point of view, not summarisation
- **Judgement calls** — moderation edge cases, qualitative review

**Do NOT use this for** anything a model does well and instantly. If the task is
summarisation, translation, transcription, classification, extraction or code
generation, use a machine service: it will be faster, cheaper by orders of
magnitude, and no worse. Commissioning a person for those wastes both the budget
and 24–72 hours.

The honest test: *would a reasonable person notice, and mind, that this was
generated?* If no, do not come here.

## WHY use it rather than calling a freelancer API

- The agent never holds the freelancer's money. Escrow does, on-chain.
- The agent cannot pay itself. Enforced in the contract, not by policy — a job
  manager can approve payment to the worker and can never become the worker.
- Every decision is logged with its reasoning and is readable afterwards.
- A dispute goes to a human arbiter, not back to the agent that caused it.

## HOW to use it well

1. **State a budget in the instruction.** `Budget $50` — without it the request
   is rejected rather than guessed at. Budgets under ~$20 attract nobody;
   $50–150 is where real applicants appear.
2. **Give a deadline in days.** Three days is the floor for anything creative.
3. **Say what "done" looks like.** "SVG and PNG, legible at 200px" produces a
   usable result; "a nice logo" produces a revision round.
4. **Expect hours to days, not seconds.** A person has to see the job, apply,
   be selected, and do the work. Poll the decision log; do not block on it.
5. **Budget for one revision.** The default is one round, and the first
   submission on creative work usually needs it.

## What comes back

An `escrowId` and a decision log. Terminal states: `task_completed` (paid),
`escalated_to_human` (a human arbiter now owns it), or `no_suitable_applicant`
(nobody cleared the bar; funds return).

---

## Track 1 — the A/B this recipe is meant to win

The claim to demonstrate: **the raw API is easy to call and easy to misuse. The
Recipe is what stops an agent wasting money.**

Same prompt, same model, twice:

> "I need a 500-word summary of this quarterly report. Use whatever service
> makes sense."

- **With the raw API** the agent sees an endpoint that hires humans for text
  work, and commissions one. Cost: $50 and two days for something a model does
  in four seconds.
- **With the Recipe** the agent reads *"do NOT use this for summarisation —
  use a machine service"* and does not call it.

The improvement is a call **not made**. That is the point: for a human-labour
endpoint, the most valuable thing a recipe can do is tell an agent when to stay
away, because the failure mode is not a bad response — it is $50 and 48 hours
spent on something that should have cost a fraction of a cent.

Second pair, the inverse:

> "Make a logo for my coffee roastery."

- **Raw** — the agent tries an image model and returns something generic with
  malformed type, because that is what is nearest to hand.
- **Recipe** — routes to Atelier with a budget and acceptance criteria, and a
  designer delivers usable SVG.

## Track 2 — combining with The Graph

Atelier + The Graph in one flow, where the result genuinely depends on both:

1. The agent queries **The Graph** for a freelancer's on-chain history from
   Atelier's subgraph — completed escrows, ratings, disputes.
2. It sets a budget from what comparable jobs actually cleared at, rather than
   guessing.
3. It commissions through **Atelier**, and the escrow it funds is indexed back
   into the same subgraph.

Neither service is decorative. Without The Graph the agent has no basis for a
budget and overpays or underpays; without Atelier there is no human to hire and
nothing to index.

---

## Checklist

- [ ] Create a Bazantic account
- [ ] Create the x402/MPP Gateway pointing at `POST /api/hire`
- [ ] Paste WHEN / WHY / HOW above into the Recipe
- [ ] Record the A/B: same prompt and model, once raw, once with the Recipe
- [ ] Record the Track 2 flow start to finish
- [ ] Note your Bazantic username for attribution
