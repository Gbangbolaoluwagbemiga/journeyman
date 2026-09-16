# Hosting the Autopilot daemon

The daemon is the only part of Atelier that still runs on a laptop, and it is
the part a judge is most likely to want to see working: the Circle Agent Stack
prize is about an agent that transacts, and an agent that is asleep transacts
nothing. Everything below is already in the repo — `Dockerfile`, `railway.toml`
with a healthcheck, `PORT` read from the environment. What is left is the
clicks.

**Not Vercel, not any serverless host.** The daemon holds a long-lived Telegram
poll open, keeps a SQLite file, and runs a timer loop. A function that is frozen
between requests cannot do any of those. It needs a container that stays up.

---

## 1. Create the service

<https://railway.app> → your existing Atelier project → **New** → **GitHub Repo**
→ this repository.

Then, in the new service's **Settings**:

| Setting | Value |
|---|---|
| Root Directory | `agent/daemon` |
| Builder | Dockerfile (auto-detected from `railway.toml`) |

Railway reads [`railway.toml`](../agent/daemon/railway.toml) for the rest: the
healthcheck path `/healthz`, a 30-second timeout, and restart-on-failure.

---

## 2. Attach a volume — do this before the first deploy

**Settings → Volumes → New Volume**, mount path **`/app/data`**.

Skip this and every deploy silently wipes the agent's memory: its task table,
its decision log, the review history that limits how many revision rounds a
freelancer gets. The daemon will look healthy and will have forgotten every job
it was running.

---

## 3. Variables

Copy these across from `agent/daemon/.env`. The daemon starts without most of
them and simply does less; the ones marked **required** are the ones without
which it cannot act at all.

| Variable | Why |
|---|---|
| `ATELIER_CONTRACT_ADDRESS` | **Required.** The proxy it hires and pays through |
| `ARC_RPC_URL` | **Required.** Chain access |
| `CIRCLE_API_KEY` · `CIRCLE_ENTITY_SECRET` | **Required.** Without these it holds no wallet and signs nothing |
| `CIRCLE_WALLET_ID` · `CIRCLE_WALLET_ADDRESS` | **Required.** The agent's own treasury |
| `GROQ_API_KEY` | **Required.** No model, no hiring decision |
| `GRAPH_URL` | Reads applications from the subgraph. Falls back to the chain without it, more slowly |
| `API_URL` · `API_SECRET` | Lets the agent write notifications for web users. Without them only Telegram users hear anything |
| `PUBLIC_APP_URL` | Every link the bot sends. Wrong value = every link goes to the wrong app |
| `TELEGRAM_BOT_TOKEN` | The worker-facing product. See the warning below |
| `GOOGLE_CLIENT_ID` | Google sign-in for managed workers |
| `HIRE_SCORE_THRESHOLD` | The hiring bar. Model-dependent — see below |
| `WORKER_WALLET_SET_ID` | Minting a wallet per freelancer |
| `MAX_JOB_BUDGET_USDC` · `DAILY_SPEND_CAP_USDC` | Spend limits. Set them |

Do **not** set `PORT`. Railway injects it, and the daemon reads it.

### Two things that will bite

**Only one process may poll Telegram.** `getUpdates` is a long poll and Telegram
hands each update to exactly one caller. Run the daemon locally *and* on Railway
with the same `TELEGRAM_BOT_TOKEN` and the two will steal messages from each
other — the bot will look like it is dropping every other reply. Stop the local
one, or leave `TELEGRAM_BOT_TOKEN` unset on Railway until you are ready to cut
over.

**The hiring bar is a property of the model, not a product decision.** If you
change `GROQ_MODEL`, re-check `HIRE_SCORE_THRESHOLD` against scoring history
before trusting it. A model swap once took hiring from nine-in-nine to one-in-
nine while every dashboard still read healthy, which is why `/healthz` reports
the model and the bar together.

---

## 4. Point the web app at it

Railway gives the service a domain. On Vercel, set:

```
VITE_AGENT_API_URL=https://<your-daemon>.up.railway.app
```

and redeploy. It is empty in production today, which is why the Autopilot
surfaces in the deployed app have nothing to talk to.

---

## 5. Check it

```bash
curl -s https://<your-daemon>.up.railway.app/healthz
```

```json
{
  "ok": true,
  "commit": "12aa076",
  "uptimeSeconds": 42,
  "model": "openai/gpt-oss-120b",
  "hireScoreThreshold": 55
}
```

`model` and `hireScoreThreshold` are in there deliberately: a daemon running the
right code against the wrong model is invisible from outside, and that exact
combination once quietly stopped it hiring anyone.

Then confirm it can see its own money:

```bash
curl -s https://<your-daemon>.up.railway.app/api/wallet
```

An agent with an empty treasury cannot pay gas, so it cannot hire. Top it up at
the address that returns.

---

## What changes once it is up

The Autopilot path works for someone who is not you: a client hands a job over
in the deployed app, and the agent picks it up within a poll — the sweep looks
for escrows naming it on-chain, so it finds jobs it never posted
([`adoptDelegated.ts`](../agent/daemon/src/agent/adoptDelegated.ts)). Applicants
get told what happened to their application on the web as well as on Telegram
([`notify/web.ts`](../agent/daemon/src/notify/web.ts)). And a judge following
the deployed link sees an agent that moves money rather than a description of
one.

## If a fix you just made does not appear in the browser

The project lives on iCloud Drive, and file watching there stops working after
a while — silently. A Vite dev server left running for a day keeps serving the
modules it loaded when it started, and no amount of hard-refreshing helps,
because the browser is asking correctly and the server is answering with old
code.

It looks exactly like a bug in whatever you just changed, and it cost most of
an evening chasing a job-manager badge that was already fixed.

```bash
lsof -ti:5173 | xargs kill
rm -rf app/node_modules/.vite     # its transform cache, which also goes stale
(cd app && npm run dev)
```

To check what is actually being served, ask the dev server rather than the
browser — it returns the transformed source:

```bash
curl -s http://localhost:5173/src/hooks/use-job-manager.ts | grep reverted
```
