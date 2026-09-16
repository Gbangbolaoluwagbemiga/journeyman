# Recreating the Supabase project

The old project (`boccczvfpxbomsowcban`) no longer resolves — DNS returns
NXDOMAIN, from this machine and from Railway alike, so it is the project that is
gone, not the network. Free-tier Supabase projects are paused after a week of
inactivity and deleted after a further period; a deleted project cannot be
restored and the reference cannot be reused.

Nothing in it custodied money. The escrow is on Arc. What was lost is the prose
around it: notifications, chat, cover letters, uploaded deliverables. The app
now degrades to empty rather than erroring, so it works without any of this —
but the bell stays silent and chat is unavailable until you do the below.

**Fifteen minutes, five steps.**

---

## 1. Make a new project

<https://supabase.com/dashboard/projects> → **New project**

| Field | What to put |
|---|---|
| Name | `atelier` |
| Database password | Generate one. You will not need it again — the API uses keys, not the password. Save it anyway |
| Region | Whichever is closest to your Railway region |
| Plan | Free is fine |

Provisioning takes a couple of minutes.

**Keep it alive.** A free project pauses after ~7 days with no activity, and
that is what killed the last one. Either open the dashboard once a week, or
accept that you may repeat this. Before a demo or judging, check it responds
first — `curl` in step 5 does that in one line.

---

## 2. Run the schema

<https://supabase.com/dashboard/project/_/sql/new> → paste
[`app/supabase/setup.sql`](../app/supabase/setup.sql) → **Run**.

That one file is every migration concatenated in dependency order, and it is
safe to run twice — each `create policy` has a matching `drop policy if exists`
in front of it, which the raw migrations do not. Paste the whole thing; do not
run the migrations individually unless you are adding a new one.

It creates:

| | |
|---|---|
| `notifications` | the bell in the top bar |
| `messages` | client ↔ freelancer chat |
| `applications` | cover letters, beside the on-chain application |
| `dispute_resolutions` | why an arbiter split a milestone the way they did |
| `archived_escrows` | the per-wallet "hide this job" list |
| `milestone-attachments` | storage bucket for deliverables, 10 MB, public read |

You should see `Success. No rows returned`.

---

## 3. Copy the two values

<https://supabase.com/dashboard/project/_/settings/api-keys>

- **Project URL** — `https://<ref>.supabase.co`
- **Secret key** — under *Secret keys*, `sb_secret_…`, click the eye to reveal

Take the **secret** key, not the publishable one. Supabase renamed these: what
used to be `service_role` is now `sb_secret_…`, and what used to be `anon` is now
`sb_publishable_…`. (The old pair still exists under the *Legacy anon,
service_role API keys* tab; either generation works, but a new project should
use the new one.)

| | Old name | Use |
|---|---|---|
| `sb_publishable_…` | `anon` | Browser-safe, subject to RLS. **We do not use it** — the frontend never talks to Supabase |
| `sb_secret_…` | `service_role` | Full access, bypasses RLS. Server-only. **This is the one** |

It goes in `SUPABASE_SERVICE_ROLE_KEY` — the variable keeps the old name, and
renaming it would be a deploy-time outage for the sake of tidiness.

**Why the secret key and not the publishable one.** The backend is the only
thing that talks to this database and it authenticates its own callers with
`API_SECRET`. More pointedly, `notifications` has no RLS enabled at all — so a
publishable key reaching a browser would let anyone read and write everyone
else's notifications straight against the REST API. The policies in `setup.sql`
cover the other three tables; the secret-key-on-the-server rule is what covers
that one.

**The secret key is a full-access credential.** It belongs only in Railway's
variables and your local `backend/.env`. It must never reach the frontend, a
`VITE_` variable, a screenshot, or a commit — anything prefixed `VITE_` is
compiled into the JavaScript every visitor downloads.

If one is ever exposed, rotate it: the **⋮** menu beside the key in that same
page. Rotating invalidates the old value immediately, so update Railway in the
same sitting.

---

## 4. Set them on Railway

<https://railway.app> → your Atelier service → **Variables**

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<the service_role secret>
```

Railway redeploys on save. Put the same two in `backend/.env` for local work.

Nothing on Vercel changes — the frontend never talks to Supabase directly.

---

## 5. Check it actually worked

```bash
curl -s https://atelier-production-be62.up.railway.app/health
```

Want: `{"ok":true,"groq":true,"supabase":true}`

`supabase` here means *reachable*, not *configured* — the endpoint fetches the
REST root with a 3-second timeout. It used to check only that the two variables
existed, which is why it reported a dead project as healthy for days.

Then, with your API secret:

```bash
curl -s -H "Authorization: Bearer $API_SECRET" \
  "https://atelier-production-be62.up.railway.app/v1/notifications?wallet=0xYourAddress"
```

Want: `{"notifications":[]}` — an empty list with **no** `degraded` flag.

`{"notifications":[],"degraded":true}` means the API is up but cannot see the
database: the URL or key is wrong, or the project is paused. `401` means the
`Authorization` header is missing or does not match `API_SECRET`.

---

## What you get back

Notifications and chat start working, and so does something that never worked:
**the agent can now notify people.** Notifications used to be written from the
acting party's browser, so when Autopilot hired someone or released a payment,
no browser was involved and nobody was told unless they were on Telegram — the
one mode built so you need not watch the job was the one where you had to.
[`notify/web.ts`](../agent/daemon/src/notify/web.ts) closes that, and it needs
`API_URL` and `API_SECRET` in the daemon's environment to reach the API.

One bug is fixed in the new schema and worth knowing about: the original
`notifications` table had a `CHECK` allowing only four types, and the app has
been sending `message` and `rating` since those features shipped. Every one of
those inserts was rejected by the database. `setup.sql` includes the widened
constraint.
