# Atelier subgraph

Indexes the escrow contract on Arc. Consumed by Atelier's frontend and — more
importantly for the pitch — by Atelier's agent, which polls it to decide who to
hire and when to release payment. It is load-bearing infrastructure here, not a
read-only convenience.

## Why this moved off Goldsky

The Graph's ETHOnline track requires, verbatim:

> "Consume live data from a Graph provider, for example querying Subgraphs with
> an API key from **Subgraph Studio**, or streaming Substreams via **The Graph
> Market**. Mocked, local-only, or static datasets do not qualify."

Both source products read from Goldsky, which is a third-party host and does not
satisfy that. Arc *is* in The Graph's networks registry — `arc-testnet`,
`eip155:5042002`, subgraphs supported — so this is a redeploy, not a rewrite or
a chain move.

## Deploying to Subgraph Studio

1. Create a subgraph at [Subgraph Studio](https://thegraph.com/studio/), name it
   `atelier`, and pick **Arc Testnet** as the network.
2. Authenticate once with the deploy key Studio shows you:

```bash
npm run auth -- <DEPLOY_KEY>
```

3. Build and ship:

```bash
npm run codegen
npm run build
npm run deploy:studio
```

Studio then gives you a **query URL** containing an API key. That URL is what
belongs in `VITE_GRAPH_URL` (frontend) and `GRAPH_URL` (agent daemon).

Keep the API key out of git — both are `.env` values, and the frontend one ships
in the browser bundle, so use a Studio key rate-limited for public use rather
than an unrestricted one.

## What it indexes

| Entity | |
|---|---|
| `Escrow` | the job: parties, amounts, status, deadline, **and its Autopilot manager** |
| `Milestone` | per-milestone state, submissions, approvals, disputes |
| `Application` | who applied, with cover letter and proposed timeline |
| `Rating` | on-chain reputation, 1–5 |
| `Evidence` | IPFS CIDs attached to disputes |
| `ManagerEvent` | **new** — every Autopilot appointment and revocation |

### Why `ManagerEvent` exists alongside `Escrow.jobManager`

`jobManager` answers *who manages this now*. `ManagerEvent` answers *who managed
it when that milestone was approved* — which is the question that matters in a
dispute. An arbiter needs to know whether a human or an agent made the call
being argued about, and by the time they look the client may have revoked,
leaving a pointer that says "nobody" over a decision an agent actually made.

### A note on what this makes public

`Escrow.jobManager` is queryable by anyone. That is deliberate: clients,
arbiters and anyone auditing the protocol should be able to see who was
authorised to act.

It is **not** surfaced to freelancers anywhere in Atelier's UI, because a worker
must not be able to tell whether their client is a person or an agent — see
`src/lib/atelier/actor.ts`. Transparency in the index and indistinguishability
in the product are not in conflict, but the second one has to be maintained
deliberately.

## Local

```bash
npm install
npm run codegen   # regenerate types after an ABI or schema change
npm run build
```

The ABI is read straight from the Foundry artifact at
`../contracts/solidity/out/Atelier.sol/Atelier.json`, so run `forge build`
first if the contract changed.
