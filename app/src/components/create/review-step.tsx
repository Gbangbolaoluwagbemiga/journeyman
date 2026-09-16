import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { YieldChoice } from "@/components/create/yield-choice";
import { AlertTriangle, Clock, DollarSign, User } from "lucide-react";
import { WHITELISTED_TOKENS } from "./project-details-step";

/** 2.5%, as the contract charges it. */
const PLATFORM_FEE_BP = 250;

interface Milestone {
  description: string;
  amount: string;
}

interface ReviewStepProps {
  formData: {
    projectTitle: string;
    projectDescription: string;
    duration: string;
    totalBudget: string;
    beneficiary: string;
    token: string;
    useNativeToken: boolean;
    isOpenJob: boolean;
    milestones: Milestone[];
    yieldOptIn: boolean;
  };
  onConfirm: () => void;
  onYieldChange: (next: boolean) => void;
  isSubmitting: boolean;
  isContractPaused: boolean;
  isOnCorrectNetwork?: boolean;
  walletBalance?: string;
}

export function ReviewStep({
  formData,
  onConfirm,
  onYieldChange,
  isSubmitting,
  isContractPaused,
  isOnCorrectNetwork = true,
  walletBalance,
}: ReviewStepProps) {
  const totalMilestoneAmount = formData.milestones.reduce(
    (sum, milestone) => sum + Number.parseFloat(milestone.amount || "0"),
    0
  );

  const isTotalValid =
    Math.abs(totalMilestoneAmount - Number.parseFloat(formData.totalBudget)) <
    0.01;

  const budget = Number.parseFloat(formData.totalBudget || "0");
  const balance = Number.parseFloat(walletBalance || "0");
  const hasInsufficientBalance =
    formData.useNativeToken && balance > 0 && budget > balance;

  const tokenSymbol = formData.useNativeToken
    ? "Native USDC"
    : WHITELISTED_TOKENS.find(t => t.address === formData.token)?.symbol || formData.token || "Not selected";

  return (
    <Card className="glass border-primary/20 p-6">
      <CardHeader>
        <CardTitle>Review & Confirm</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-5">
          <div className="space-y-2">
            <h3 className="font-semibold text-lg">{formData.projectTitle}</h3>
            <p className="text-muted-foreground">
              {formData.projectDescription}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">{formData.duration} days</span>
            </div>
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">
              {Number(formData.totalBudget || 0).toFixed(2)}{" "}
              {tokenSymbol}
            </span>
          </div>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm">
                {formData.isOpenJob ? "Open Job" : "Direct Assignment"}
              </span>
            </div>
          </div>

          {formData.beneficiary && (
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Beneficiary:</p>
              <p className="font-mono text-sm">{formData.beneficiary}</p>
            </div>
          )}

          <div className="space-y-3">
            <h4 className="font-medium">
              Milestones ({formData.milestones.length})
            </h4>
            <div className="space-y-2">
              {formData.milestones.map((milestone, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between p-2 bg-muted/20 rounded"
                >
                  <span className="text-sm">{milestone.description}</span>
                  <span className="text-sm font-medium">
                    {Number(milestone.amount || 0).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">Total Milestone Amount:</span>
              <span className="font-semibold">
                {totalMilestoneAmount.toFixed(2)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-medium">Project Budget:</span>
              <span className="font-semibold">
                {Number(formData.totalBudget || 0).toFixed(2)}
              </span>
            </div>
            {!isTotalValid && (
              <p className="text-sm text-destructive mt-3">
                ⚠️ Milestone amounts don't match project budget
              </p>
            )}
            {/*
              The number the wallet is about to ask for, on the screen before
              it does.

              This said "Platform fee: covered by what the escrow earns", which
              was false twice over: the fee is charged whichever option you
              pick, and what comes back is a refund out of later earnings. A
              client read that, chose the yield option, and then watched their
              wallet request budget + fee anyway — with no line anywhere on this
              page that added up to the figure they were being shown.
            */}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Platform fee (2.5%)</span>
              <span data-testid="fee-line">
                {formData.yieldOptIn ? (
                  <>
                    <span className="line-through opacity-50">
                      {(budget * PLATFORM_FEE_BP / 10000).toFixed(2)}
                    </span>{" "}
                    waived
                  </>
                ) : (
                  (budget * PLATFORM_FEE_BP / 10000).toFixed(2)
                )}
              </span>
            </div>
            <div className="flex items-center justify-between font-semibold border-t border-border/40 pt-2 mt-2">
              <span>You approve now</span>
              <span data-testid="approval-total">
                {(formData.yieldOptIn
                  ? budget
                  : budget + budget * PLATFORM_FEE_BP / 10000
                ).toFixed(4)}
              </span>
            </div>
            {hasInsufficientBalance && (
              <p className="text-sm text-destructive mt-3 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                Insufficient balance — you have {balance.toFixed(6)} USDC but need {budget.toFixed(6)} USDC (plus platform fee)
              </p>
            )}
          </div>
        </div>

        {/* Asked here because this is the last screen before signing, and
            because the contract will not let it be asked again. */}
        <div className="border-t pt-6">
          <YieldChoice
            value={formData.yieldOptIn}
            onChange={onYieldChange}
            fee={budget * PLATFORM_FEE_BP / 10000}
            disabled={isSubmitting}
          />
        </div>

        <div className="flex gap-4">
          <button
            type="button"
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (
                !isSubmitting &&
                !isContractPaused &&
                isTotalValid &&
                isOnCorrectNetwork &&
                !hasInsufficientBalance
              ) {
                try {
                  await onConfirm();
                } catch (error) {
                }
              }
            }}
            disabled={
              isSubmitting ||
              isContractPaused ||
              !isTotalValid ||
              !isOnCorrectNetwork ||
              hasInsufficientBalance
            }
            className="flex-1 bg-primary text-primary-foreground px-6 py-3 rounded-lg font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSubmitting ? "Creating Escrow…" : "Create Escrow"}
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
