# Running Atelier locally

Three services. Start them in any order; the frontend degrades gracefully if the
others are missing rather than erroring.

| Service | Port | What it is | Needed for |
|---|---|---|---|
| **Frontend** | `5173`/`5174` | Atelier — React + Vite | everything |
| **Atelier backend** | `8787` | Express — AI writers, gasless relay, uploads, messages | cover letters, file upload, chat |
| **Agent daemon** | `8080` | Autopilot's brain — runs 24/7, holds keys, and long-polls [@The_Atelierbot](https://t.me/The_Atelierbot) | decision log, Autopilot mode, Telegram |

## First time

Secrets are not in this repo. Start from the checked-in examples and fill in
your own keys:

```bash
cp app/.env.example           app/.env
cp backend/.env.example   backend/.env
cp agent/daemon/.env.example  agent/daemon/.env
```

Then two edits, because both backends default to port 8787:

```bash
# agent/daemon/.env
PORT=8080

# app/.env — point Atelier at the daemon
VITE_AGENT_API_URL=http://localhost:8080
```

Install:

```bash
(cd app && npm install)
(cd backend && npm install)
(cd agent/daemon && npm install)
```

Contracts need OpenZeppelin fetched — see
[`contracts/solidity/README.md`](app/contracts/solidity/README.md).

## Start

```bash
(cd backend      && npm run dev)   # :8787
(cd agent/daemon && npm run dev)   # :8080  — `npm start` does NOT watch
(cd app          && npm run dev)   # :5173 or :5174
```

`npm run dev` for the daemon, not `npm start`. `start` is `tsx src/index.ts`
with no watcher, so it keeps serving the code it was launched with and nothing
says so. An afternoon went into debugging a fix that had already landed and was
simply not running — and the same afternoon produced the Vite version of the
same trap, which is written up in
[`docs/daemon-hosting.md`](docs/daemon-hosting.md). If a change appears to have
no effect, check what is actually running before you check the change.

Check all three:

```bash
curl -s -o /dev/null -w "backend  %{http_code}\n" http://localhost:8787/health
curl -s -o /dev/null -w "daemon   %{http_code}\n" http://localhost:8080/api/tasks
curl -s -o /dev/null -w "frontend %{http_code}\n" http://localhost:5174/
```

## Seeing the Autopilot surfaces

A freshly started daemon has an empty database, so the decision log renders
nothing. Seed two demo jobs — one the agent runs cleanly, one that escalates to
a human:

```bash
node scripts/seed-local-demo.mjs 1 2
```

Then open **http://localhost:5174/dev** — a dev-only page that renders the
Autopilot surfaces directly, so you can see them without a wallet. The route
does not exist in production builds.

Every seeded reasoning is prefixed `[LOCAL DEMO]`. It is for looking at the UI,
**not** for screenshots, videos, or anything a judge sees. Undo with
`rm -rf agent/daemon/data`.

## What you can click right now

| Works | Where |
|---|---|
| The whole existing Atelier app | everywhere — nothing was removed |
| Post a Job → mode chooser | `/post` |
| Autopilot compose, with validation | `/post/autopilot` |
| Decision log, live from the daemon | `/dev`, or inside your own job on `/my-jobs` |
| Autopilot control (delegate / revoke) | `/my-jobs` → expand a job you funded |

**Delegation will fail on-chain.** The deployed contract at `0x6142…ab59`
predates `setJobManager`; the button is wired and correct, and it reverts until
the UUPS proxy is deployed. See
[`docs/adr/0001-autopilot-delegation.md`](docs/adr/0001-autopilot-delegation.md).

## Tests

```bash
(cd app && npm test)                       # 63 unit/component
(cd backend && npx vitest run)         # 32 backend routes
(cd app/contracts/solidity && forge test)  # 47 contract, incl. fuzz + upgrade
(cd app && npm run e2e)                    # 33 full-stack, needs all 3 running
```

The E2E suite drives a real browser against the real services. It is the only
layer that catches what breaks *between* them — a dead route, a missing CORS
header, a response shape that drifted. Everything else passes with the daemon
switched off, which is both the point of those tests and their limit.

## The Telegram bot

[@The_Atelierbot](https://t.me/The_Atelierbot) is the same worker service as
`/get-hired`, reached from a chat. The daemon long-polls it, so it is live
whenever the daemon is running and dormant when `TELEGRAM_BOT_TOKEN` is unset —
never half-working.

```
/start      join and get a wallet        /balance   what you have earned
/jobs       open jobs                    /withdraw  send earnings out
/mine       your work                    /link      use your own wallet instead
/watch      alerts when jobs appear      /help      everything
```

Telegram and web accounts live in separate namespaces — `("telegram", userId)`
against `("web", email)` — so neither can claim the other's wallet.
