/**
 * POST A JOB — the fork where Atelier's product decision becomes visible.
 *
 * Two ways to run a job, and the choice is NOT "hire a person or hire a
 * machine". The freelancer is a human in both. What the client picks here is
 * who does the *labour of managing*: writing the brief, reading twenty
 * applications, judging whether the delivered work is good.
 *
 * The screen has to make that unmistakable, because the obvious misreading —
 * "Autopilot means an AI does my logo" — would be the worst thing a judge or a
 * user could walk away believing. Hence the shared footer: both columns end at
 * the same escrow, and the rights that matter stay with the client in both.
 *
 * Colour is doing real work here. This is most people's first encounter with
 * teal-is-human / amber-is-agent, so the two cards are the legend — never
 * stated, just demonstrated, and every amber surface later in an Autopilot job
 * refers back to this moment.
 */

import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ModeCardProps {
  actor: "actor-human" | "actor-agent";
  eyebrow: string;
  title: string;
  blurb: string;
  /** What the client does themselves in this mode. */
  youDo: string[];
  /**
   * What Autopilot takes off their hands.
   *
   * Rendered even when empty, with an explicit "nothing" — the two cards are a
   * comparison, and a column that simply omits the section leaves a hole where
   * the reader is trying to look across. Saying "nothing, this one is yours"
   * answers the question the gap was posing.
   */
  agentDoes: string[];
  cta: string;
  onPick: () => void;
  delay: number;
}

function ModeCard({
  actor,
  eyebrow,
  title,
  blurb,
  youDo,
  agentDoes,
  cta,
  onPick,
  delay,
}: ModeCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay }}
      className={`${actor} group relative flex flex-col rounded-2xl actor-panel p-6 sm:p-8 transition-shadow hover:actor-glow`}
    >
      <span className="actor-chip self-start">
        <span className="actor-dot" />
        {eyebrow}
      </span>

      <h2 className="font-display text-3xl font-bold mt-5 actor-text">
        {title}
      </h2>
      <p className="text-muted-foreground mt-3 leading-relaxed">{blurb}</p>

      <div className="mt-7 space-y-5 flex-1">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            You do
          </h3>
          <ul className="mt-2.5 space-y-2">
            {youDo.map((line) => (
              <li key={line} className="flex gap-2.5 text-sm">
                <Check
                  className="h-4 w-4 mt-0.5 shrink-0 actor-text"
                  aria-hidden="true"
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Autopilot does
          </h3>
          {agentDoes.length > 0 ? (
            <ul className="mt-2.5 space-y-2">
              {agentDoes.map((line) => (
                <li key={line} className="flex gap-2.5 text-sm">
                  <Check
                    className="h-4 w-4 mt-0.5 shrink-0 actor-text"
                    aria-hidden="true"
                  />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2.5 text-sm text-muted-foreground">
              Nothing. This one is entirely yours.
            </p>
          )}
        </div>
      </div>

      <Button
        onClick={onPick}
        size="lg"
        className="mt-8 w-full bg-[var(--actor)] text-[var(--actor-fg)] hover:bg-[var(--actor)] hover:opacity-90"
      >
        {cta}
        <ArrowRight className="h-4 w-4 ml-2 transition-transform group-hover:translate-x-0.5" />
      </Button>
    </motion.div>
  );
}

export default function PostJobPage() {
  const navigate = useNavigate();

  return (
    <div className="container mx-auto px-4 py-12 sm:py-16 max-w-5xl">
      <motion.header
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="text-center max-w-2xl mx-auto"
      >
        <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight">
          Post a job
        </h1>
        <p className="text-lg text-muted-foreground mt-4 leading-relaxed">
          A real person does the work either way. Choose who does the work of{" "}
          <em>managing</em> it.
        </p>
      </motion.header>

      <div className="grid md:grid-cols-2 gap-5 sm:gap-6 mt-12">
        <ModeCard
          actor="actor-human"
          eyebrow="Manual"
          title="You run it"
          blurb="The full escrow you already know. You write the brief, choose who gets hired, and approve each milestone yourself."
          youDo={[
            "Write the brief and set the milestones",
            "Read applications and pick the freelancer",
            "Review each delivery and release payment",
          ]}
          agentDoes={[]}
          cta="Set up manually"
          onPick={() => navigate("/create")}
          delay={0.05}
        />

        <ModeCard
          actor="actor-agent"
          eyebrow="Autopilot"
          title="The agent runs it"
          blurb={
            'Say what you want in a sentence — "logo, $50, three days" — and Autopilot handles the rest. You still hold the money.'
          }
          youDo={[
            "Say what you want, and fund the escrow",
            "Watch the decision log, step in whenever you like",
          ]}
          agentDoes={[
            "Turns your sentence into a proper brief",
            "Scores every applicant and hires one",
            "Reviews the delivery and releases payment",
          ]}
          cta="Hand it to Autopilot"
          onPick={() => navigate("/post/autopilot")}
          delay={0.12}
        />
      </div>

      {/*
        The load-bearing paragraph on this page.

        Delegating the management of a job is only reasonable if delegating it
        costs you nothing you would miss. Both columns end here, in the same
        contract, with the same rights — and that is what makes the amber column
        safe to choose rather than a leap of faith.

        This paragraph is now backed by a deployed contract, not a promise.
        The escrow contract at 0xA93F832ccaAb62123f82D4c92ec897A6Bdb252BE carries a scoped
        job manager that may hire, approve and reject and nothing else — no
        dispute, no cancel, no withdrawal, and it can never become the
        beneficiary. The one-way key is enforced at two points and proved by a
        fuzzed invariant over 128,000 calls. See
        docs/adr/0001-autopilot-delegation.md.

        What it still does NOT say, and must not: that the arrangement is
        trustless. The contract cannot take a client's money; the proxy owner can
        replace the implementation. Both clauses, always.
      */}
      <motion.section
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.4, delay: 0.22 }}
        className="mt-10 rounded-2xl glass p-6 sm:p-7 text-center"
      >
        <h2 className="font-display text-xl font-semibold">
          Either way, the money works the same
        </h2>
        <p className="text-sm text-muted-foreground mt-3 max-w-2xl mx-auto leading-relaxed">
          Your USDC sits in the same on-chain escrow, funded by your wallet and
          held by the same contract. Autopilot can pay the freelancer — it can
          never pay itself, move your funds anywhere else, or settle a dispute.
          It can call in a human arbiter when it runs out of revision rounds, and
          so can you or the freelancer at any point; who wins one is never the
          agent's to decide.
        </p>
      </motion.section>
    </div>
  );
}
