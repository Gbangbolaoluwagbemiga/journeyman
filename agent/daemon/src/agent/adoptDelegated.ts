// adoptDelegated.ts — pick up jobs a client handed to us from the app.
//
// WHY THIS EXISTS
//
// The daemon only ever worked on tasks it created itself, through /api/instruct
// or /api/hire. A client posting through Autopilot in the app takes a different
// route: they fund the escrow from their own wallet and call setJobManager,
// which names us on-chain. Nothing told the daemon.
//
// So the delegation was real and completely inert. The app reads jobManager
// from the chain and correctly said "Autopilot is running this job", the
// contract would have let us hire and approve, and the poller never looked
// because it iterates its own task table. The client watched an agent that had
// never heard of their job.
//
// This closes that gap from the chain side: find escrows where we are the
// manager, and give each one a task row so the existing poller takes it from
// there. Nothing else about the loop changes.
import { getAddress, type Abi } from "viem";
import atelierAbi from "../web3/AtelierABI.json" with { type: "json" };
import { config } from "../config.js";
import { getLogClient, getPublicClient } from "../web3/atelier.js";
import { createCircleSigner } from "../circle/circleSigner.js";
import * as store from "../store.js";
import { generateBrief } from "./BriefGenerator.js";
import { getPrefs } from "./handover.js";

const abi = atelierAbi as Abi;

interface RawEscrow {
  depositor: string;
  beneficiary: string;
  totalAmount: bigint;
  deadline: bigint;
  status: number;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
}

/** Escrow ids currently naming `manager` on-chain, newest assignment winning. */
async function delegatedTo(
  manager: `0x${string}`,
): Promise<{ ids: bigint[]; complete: boolean }> {
  const client = getLogClient();
  const event = {
    type: "event",
    name: "JobManagerSet",
    inputs: [
      { name: "escrowId", type: "uint256", indexed: true },
      { name: "manager", type: "address", indexed: true },
    ],
  } as const;

  const latest = await client.getBlockNumber();

  /*
   * REMEMBER WHERE THE LAST SWEEP GOT TO.
   *
   * This rescanned from the contract's deploy block every time — about 780,000
   * blocks in 9,000-block windows, so eighty-seven getLogs calls, every fifteen
   * seconds. The RPC started answering "rate limit exceeded" and every one of
   * them failed, which meant a client handing a job to Autopilot was quietly
   * never picked up. The sweep that found nothing looked exactly like a sweep
   * with nothing to find.
   *
   * An appointment, once seen, stays true — the mapping below is what decides
   * whether it still holds. So the ids are accumulated across sweeps and only
   * the new blocks are read, which turns eighty-seven requests into one.
   *
   * Deliberately rewound a little each time: a log read right at the tip can
   * miss a reorg's worth of blocks, and re-reading a few thousand costs one
   * request while missing an appointment costs somebody their job.
   */
  const CURSOR_KEY = `scan_cursor:jobmanager:${manager.toLowerCase()}`;
  const SEEN_KEY = `scan_seen:jobmanager:${manager.toLowerCase()}`;
  const REWIND = 5_000n;

  const seen = new Set<bigint>();
  try {
    const saved = store.getPollerText(SEEN_KEY);
    if (saved) for (const id of JSON.parse(saved) as string[]) seen.add(BigInt(id));
  } catch {
    /* a corrupt cursor just means one full rescan */
  }

  const savedCursor = store.getPollerInt(CURSOR_KEY);
  const startFrom =
    savedCursor && BigInt(savedCursor) > config.atelierDeployBlock
      ? BigInt(savedCursor) - REWIND
      : config.atelierDeployBlock;

  /*
   * Bounded work, and keep whatever ground it gains.
   *
   * Saving the cursor only at the end was a deadlock: the first sweep has
   * 780,000 blocks to read, the RPC rate-limits somewhere in the middle, the
   * whole sweep throws, and nothing is remembered — so the next sweep starts
   * from the deploy block and fails in exactly the same place, forever.
   *
   * Each window is committed as it succeeds, so a sweep that dies half way
   * still moves the mark. And a sweep only does so much: catching up happens
   * over a few passes instead of one impossible one, while a daemon that is
   * already caught up does a single window and stops.
   */
  const MAX_WINDOWS_PER_SWEEP = 25;

  let cursor = startFrom;
  let windows = 0;
  let rateLimited = false;

  for (let from = startFrom; from <= latest; from += config.logRangeLimit + 1n) {
    if (windows >= MAX_WINDOWS_PER_SWEEP) break;
    const to = from + config.logRangeLimit > latest ? latest : from + config.logRangeLimit;

    try {
      const logs = await client.getLogs({
        address: config.atelierAddress,
        event,
        args: { manager },
        fromBlock: from,
        toBlock: to,
      });
      for (const log of logs) {
        const id = (log as { args?: { escrowId?: bigint } }).args?.escrowId;
        if (id !== undefined) seen.add(id);
      }
      cursor = to;
      windows++;
    } catch (err) {
      /* Stop on the first refusal rather than hammering through the rest —
         they will all be refused too, and the next sweep resumes here. */
      rateLimited = true;
      console.warn(
        `[adopt] log scan paused at block ${from} (${err instanceof Error ? err.message.split("\n")[0] : err})`,
      );
      break;
    }
  }

  /*
   * Never backwards.
   *
   * The sweep starts a little behind the mark on purpose, to re-read blocks a
   * reorg might have changed. When the very first window is then refused,
   * `cursor` is still sitting at that rewound start — and saving it moved the
   * mark BACK five thousand blocks. Every rate-limited sweep lost ground, so a
   * daemon under pressure crawled away from the head instead of toward it.
   * Watched it go 61,491,811 → 61,486,811 → 61,481,811 before catching it.
   */
  const previous = savedCursor ? BigInt(savedCursor) : 0n;
  if (cursor > previous) store.setPollerInt(CURSOR_KEY, Number(cursor));
  store.setPollerText(SEEN_KEY, JSON.stringify([...seen].map(String)));

  /*
   * Did this sweep actually see everything up to the head?
   *
   * It matters enormously, because the caller uses the answer to decide what
   * the client has REVOKED — anything delegated that is not in the list gets
   * handed back and its task deleted. A truncated scan cannot tell "revoked"
   * from "not read yet", and treating it as complete deleted the task for
   * escrow 8 while the chain still named the agent as its manager. The badge
   * vanished off the board and the agent stopped working a live job.
   *
   * That regression came in with making the scan survive rate limits: before
   * it, a refused scan threw and aborted the sweep, which was accidentally
   * safe. Surviving is right; acting on a partial answer is not.
   */
  const complete = !rateLimited && cursor >= latest;
  if (!complete) {
    console.log(`[adopt] caught up to block ${cursor} of ${latest}; resuming next sweep`);
  }

  // The event says we were appointed once; the mapping says whether we still
  // are. A revoked manager keeps its log forever, and acting on that would be
  // the agent working a job the client had already taken back.
  const still = await Promise.all(
    [...seen].map(async (id) => {
      const current = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "jobManager",
        args: [id],
      })) as string;
      return getAddress(current) === getAddress(manager) ? id : null;
    }),
  );
  return { ids: still.filter((id): id is bigint => id !== null), complete };
}

/**
 * Give every job delegated to us a task row, so the poller can run it.
 *
 * Safe to call repeatedly: a job that already has a task is skipped, and the
 * brief is regenerated only for jobs being adopted for the first time.
 */
export async function adoptDelegatedJobs(): Promise<number> {
  let signer;
  try {
    signer = createCircleSigner();
  } catch {
    return 0; // no agent wallet configured; nothing can be delegated to us
  }

  const { ids, complete } = await delegatedTo(signer.address as `0x${string}`);

  const tasks = store.listTasks(500);
  const known = new Set(tasks.map((t) => String(t.escrowId)));
  /* Reads only — every `client.` below this is a readContract. The log walk
     lives in the scan above and uses the other endpoint. */
  const client = getPublicClient();
  let adopted = 0;

  /*
   * Hand back anything the client has taken off Autopilot.
   *
   * Revoking sets jobManager to zero, and the contract refuses our next call
   * straight away — but the task row stayed, so Browse Jobs kept showing
   * "AUTOPILOT MANAGED" on a job the agent was locked out of. Only rows this
   * sweep created are dropped; a job commissioned through the API is not ours
   * to forget.
   */
  const stillOurs = new Set(ids.map(String));

  /*
   * Only when the scan saw the whole chain. A partial list means "these are the
   * appointments I managed to read", not "these are all the appointments" — and
   * handing back everything absent from a truncated read takes the agent off
   * jobs it is actively running.
   */
  if (complete) {
    for (const t of tasks) {
      if (!t.id.startsWith("delegated-")) continue;
      if (stillOurs.has(String(t.escrowId))) continue;
      store.deleteTask(t.id);
      console.log(`[adopt] escrow ${t.escrowId} was taken back by its client — released`);
    }
  }

  /*
   * And anything that has since ended.
   *
   * Revocation is not the only way a delegated job stops being work: a client
   * can cancel it, an arbiter can settle it, it can simply complete. The sweep
   * above only notices revocation, because it compares against who manages the
   * escrow — and jobManager stays set on a cancelled job forever.
   *
   * So the agent went on advertising a task for an escrow nobody could act on:
   * `delegated-4`, status "posted", on a job that had been cancelled. Harmless
   * to the chain, which refuses every call, and misleading everywhere a human
   * reads the agent's state.
   */
  for (const t of tasks) {
    if (!t.id.startsWith("delegated-")) continue;
    if (!stillOurs.has(String(t.escrowId))) continue; // handled above
    try {
      const esc = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "getEscrow",
        args: [BigInt(t.escrowId!)],
      })) as RawEscrow;
      if (esc.status !== 0 && esc.status !== 1) {
        store.deleteTask(t.id);
        console.log(`[adopt] escrow ${t.escrowId} has ended (status ${esc.status}) — released`);
      }
    } catch {
      // A failed read is not evidence the job ended. Leave it alone.
    }
  }

  for (const id of ids) {
    if (known.has(String(id))) continue;

    const esc = (await client.readContract({
      address: config.atelierAddress,
      abi,
      functionName: "getEscrow",
      args: [id],
    })) as RawEscrow;

    /*
     * Pending and InProgress, not just Pending.
     *
     * setJobManager accepts a job at any stage, so a client can hand over one
     * that already has a freelancer working -- "you handle the reviews from
     * here" is a reasonable thing to want, and the contract allows it. Adopting
     * only Pending meant that delegation was accepted on-chain and then ignored:
     * the app said Autopilot was running the job and nothing ever happened,
     * which is the same inert hand-off this sweep exists to prevent.
     *
     * Anything past InProgress is settled and has nothing left to decide.
     */
    const PENDING = 0;
    const IN_PROGRESS = 1;
    if (esc.status !== PENDING && esc.status !== IN_PROGRESS) continue;

    /*
     * The client already approved a brief in the app, and it was written into
     * the escrow's own description. Regenerate the structured form from that
     * text rather than inventing a new one, so the criteria the agent scores
     * against are the criteria the client actually agreed to.
     */
    /*
     * TELL THE GENERATOR WHAT THE JOB IS ACTUALLY WORTH.
     *
     * The description usually says nothing about money, so the model invented a
     * number — $300, then $800, then $500 for escrow 8, which holds ten dollars
     * — and every one of those tripped the per-commission cap and threw. The
     * job was never adopted, so the client's hand-over did nothing, forever, on
     * a sweep that logged the failure and moved on.
     *
     * The cap exists for commissions the agent is asked to CREATE, where the
     * model's figure becomes real money. Here the escrow is already funded and
     * the figure is overwritten from the chain a few lines below, so the guess
     * was never going to be used for anything — it just had to be plausible
     * enough not to abort.
     *
     * Stating the real budget removes the guess entirely, and makes the
     * criteria proportionate to the money while it is at it.
     */
    const fundedUsdc = Number(esc.totalAmount) / 1e6;
    const source = `${esc.projectTitle}\n\n${esc.projectDescription}\n\nBudget: $${fundedUsdc}`;
    let briefJson: string;
    try {
      const { brief } = await generateBrief(source);

      /*
       * Every number comes from the escrow, never from the description.
       *
       * The description keeps the client's original instruction, and a client
       * routinely edits the milestones before funding — "Budget $50" in the
       * prose against 5 USDC actually locked. Regenerating from the text
       * reproduced the sentence, so the bot advertised a $50 job paying $10
       * and $40 when the contract held 5, split 1 and 4. A freelancer applying
       * to that is being told a price nobody can pay them.
       *
       * The chain is the only honest source for what a job is worth, and the
       * milestone text on it is what the client actually approved. The model's
       * output is kept only for the acceptance criteria it structured.
       */
      const onChain = (await client.readContract({
        address: config.atelierAddress,
        abi,
        functionName: "getMilestones",
        args: [id],
      })) as readonly { amount: bigint; requirements: string; description: string }[];

      const decimals = 1e6; // USDC
      brief.milestones = onChain.map((m) => ({
        description: m.requirements || m.description,
        amount: Number(m.amount) / decimals,
      }));
      brief.budget = brief.milestones.reduce((sum, m) => sum + m.amount, 0);

      const secondsLeft = Number(esc.deadline) - Math.floor(Date.now() / 1000);
      brief.durationDays = Math.max(1, Math.ceil(secondsLeft / 86_400));

      /*
       * What the client approved on screen wins over what the model just wrote.
       *
       * The hand-over dialog shows the criteria and asks for a review window
       * before the signature. Regenerating here and ignoring that would mean
       * the client read one standard, agreed to it, and the agent quietly
       * worked to another — the exact surprise the dialog exists to prevent.
       * They may also have edited the criteria, and an edit nobody honours is
       * worse than no edit box at all.
       */
      const approved = getPrefs(String(id));
      if (approved) {
        if (approved.criteria.length > 0) brief.criteria = approved.criteria;
        brief.applicationWindowMinutes = approved.applicationWindowMinutes;
      }

      briefJson = JSON.stringify(brief);
    } catch (err) {
      console.error(`[adopt] escrow ${id}: could not rebuild the brief —`, err instanceof Error ? err.message : err);
      continue;
    }

    store.insertTask({
      id: `delegated-${id}`,
      escrowId: String(id),
      instruction: source,
      clientType: "human",
      // A job with a freelancer already on it skips the hiring branch and goes
      // straight to reviewing what they submit.
      status: esc.status === IN_PROGRESS ? "active" : "posted",
      briefJson,
      clientAddress: esc.depositor,
    });
    adopted++;
    console.log(`[adopt] escrow ${id} was delegated to us in the app — now running it`);
  }
  return adopted;
}
