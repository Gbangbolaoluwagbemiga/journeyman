import { Sprout, Wallet } from "lucide-react";

/**
 * WHO PAYS THE PLATFORM FEE — asked once, while the job is being posted.
 *
 * THE FEE IS GENUINELY WAIVED, WHICH IT WAS NOT AT FIRST
 *
 * This was framed as a fee choice, then found to be a lie: `createEscrow`
 * charged budget + fee whichever card you picked, and the yield merely refunded
 * it later. That refund was worth nothing. A job deploys roughly 40% of its
 * budget, so covering a 2.5% fee needs rate × days ≥ 22.8 — 228 days at 10%
 * APY, with the budget cancelling out of the inequality entirely. No freelance
 * job is long enough. The client recovered a rounding error and had no reason
 * to switch it on.
 *
 * So the contract waives the fee outright now, and the framing is true: the
 * client pays 2.5% less, today, in the number their wallet shows them.
 *
 * What the platform takes instead is 40% of what the escrow earns and a job
 * that carries a share for whoever takes it — a recruiting advantage, and the
 * reason a freelancer picks this job over an identical one. It is a certain
 * fee traded for an uncertain return, deliberately.
 *
 * WHY THIS IS NOT A SWITCH ON THE JOB PAGE
 *
 * It was, and that was wrong. The yield share is a TERM of the job, not a
 * setting on it: a freelancer reads "this escrow earns while you work and 60%
 * of what it earns is yours" on the board and applies partly because of that.
 * A client who could flip it off after hiring would be changing the deal after
 * the other side had accepted it — and the freelancer would have no recourse
 * and, realistically, no idea it had happened.
 *
 * So it is answered here, before the job exists, and the contract refuses to
 * let it change once anybody is hired. Nobody has to trust anybody about it:
 * the tag on a job card means the same thing on delivery day as it did on the
 * day it was posted.
 *
 * WHY IT IS FRAMED AS "WHO PAYS THE FEE"
 *
 * Because that is the actual decision, and it is the one the client cares
 * about. "Enable yield optimisation" is a feature name; "your fee comes back
 * out of what the escrow earns" is a reason. The freelancer's share is stated
 * in the same breath rather than buried, because a client should know they are
 * agreeing to it before they agree to it.
 */

interface Props {
  value: boolean;
  onChange: (next: boolean) => void;
  /** The platform fee in USDC, so the choice is about a real number. */
  fee: number;
  disabled?: boolean;
}

export function YieldChoice({ value, onChange, fee, disabled }: Props) {
  return (
    <div className="space-y-3" data-testid="yield-choice">
      <div>
        <h4 className="font-medium">How the platform fee gets paid</h4>
        <p className="text-sm text-muted-foreground mt-0.5">
          Choose once. It cannot be changed after someone is hired.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Option
          selected={!value}
          disabled={disabled}
          onSelect={() => onChange(false)}
          icon={Wallet}
          title="I'll pay it"
          testId="yield-choice-fee"
          body={`The fee — $${fee.toFixed(2)} — is taken when you post, and your escrow simply waits.`}
        />
        <Option
          selected={value}
          disabled={disabled}
          onSelect={() => onChange(true)}
          icon={Sprout}
          title="Let the escrow earn it"
          testId="yield-choice-yield"
          body={`No fee — you approve $${fee.toFixed(2)} less. The part no milestone can claim yet earns while the job runs, and 60% of that goes to the freelancer.`}
        />
      </div>

      {value && (
        <p className="text-xs text-muted-foreground" data-testid="yield-choice-note">
          Your next milestone payment always stays in cash, so this never delays
          paying anyone. The job carries a 🌱 tag on the board, which is part of
          why a freelancer picks it. It costs one extra signature before the
          escrow: that is what waives the fee.
        </p>
      )}
    </div>
  );
}

function Option({
  selected,
  disabled,
  onSelect,
  icon: Icon,
  title,
  body,
  testId,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: typeof Sprout;
  title: string;
  body: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={`text-left rounded-lg border p-3 transition-colors disabled:opacity-50 ${
        selected
          ? "border-primary bg-primary/5"
          : "border-muted hover:border-primary/40"
      }`}
    >
      <span className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4" aria-hidden="true" />
        {title}
      </span>
      <span className="block text-sm text-muted-foreground mt-1">{body}</span>
    </button>
  );
}
