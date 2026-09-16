# Atelier — web app

The React client. It is one of four deployables, and the documentation for all
of them lives in one place rather than four:

## → [Read the root README](../README.md)

---

**Why this file is a pointer and not a document.**

It used to be a 363-line copy of SecureFlow's README, carried over when the two
projects merged and never revised. By the time anyone noticed, it was advertising
a contract address two deployments out of date, a Goldsky subgraph we had already
replaced with Subgraph Studio, a GitHub repository under the old name, and a CI
badge pointing at a workflow in a different repo.

None of that was malice or laziness — it is just what happens to a second copy of
a document nobody has a reason to open. So there is no second copy any more.

| Looking for | Where it is |
|---|---|
| What Atelier is, and the architecture | [`README.md`](../README.md) |
| Running all four services locally | [`RUNNING.md`](../RUNNING.md) |
| Contract, subgraph and OAuth deployment | [`DEPLOY.md`](../DEPLOY.md) |
| Recreating the database | [`docs/supabase-setup.md`](../docs/supabase-setup.md) |
| Hosting the Autopilot daemon | [`docs/daemon-hosting.md`](../docs/daemon-hosting.md) |
| What we submit for, with a file and line behind each claim | [`docs/tracks.md`](../docs/tracks.md) |

```bash
npm install
npm run dev        # :5173
npm test           # component tests
npm run typecheck  # tsc -b — NOT `tsc --noEmit`, see ../app/tsconfig.json
```
