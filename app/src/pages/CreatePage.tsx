import { useState, useEffect, useMemo } from "react";
import { useWriteContract } from "wagmi";
import { CONTRACTS } from "@/lib/web3/config";
import { Button } from "@/components/ui/button";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ARC_TESTNET } from "@/lib/web3/config";

import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { categoryMarker, type CategoryId } from "@/lib/atelier/categories";
import { ProjectDetailsStep } from "@/components/create/project-details-step";
import { MilestonesStep } from "@/components/create/milestones-step";
import { ReviewStep } from "@/components/create/review-step";
import { useCreateEscrow } from "@/hooks/use-escrows";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle } from "lucide-react";
import { parseEther, parseUnits } from "viem";
import { AUTOPILOT_BRIEF_KEY } from "@/lib/atelier/agent-api";

const USDC_ADDRESS = (
  (import.meta.env.VITE_USDC_TOKEN_CONTRACT as string | undefined) ?? ""
).trim() as `0x${string}` | "";

// Native USDC has 6 decimals on Arc Testnet
function parseTokenAmount(amount: string, tokenAddress: string | undefined): bigint {
  // Validate amount
  if (!amount || amount === "0" || isNaN(Number(amount))) {
    throw new Error("Invalid amount: must be greater than 0");
  }

  // Native token (address(0)) is USDC with 6 decimals on Arc Testnet
  if (!tokenAddress || tokenAddress === "0x0000000000000000000000000000000000000000") {
    return parseUnits(amount, 6);
  }
  // USDC — 6 decimals
  if (USDC_ADDRESS && tokenAddress.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    return parseUnits(amount, 6);
  }
  // Unknown ERC-20 — default to 18
  return parseEther(amount);
}

interface Milestone {
  description: string;
  amount: string;
}

const ARC_CHAIN_ID = ARC_TESTNET.chainId;

export default function CreateEscrowPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const createEscrow = useCreateEscrow();
  const { writeContractAsync } = useWriteContract();
  const [step, setStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAIWriter, setShowAIWriter] = useState(false);
  const [currentMilestoneIndex, setCurrentMilestoneIndex] = useState<number | null>(null);
  const [isContractPaused, setIsContractPaused] = useState(false);
  const [contractConfigError, setContractConfigError] = useState<string | null>(null);
  const [isOnCorrectNetwork, setIsOnCorrectNetwork] = useState(true);
  const [errors, setErrors] = useState<{
    projectTitle?: string;
    projectDescription?: string;
    duration?: string;
    totalBudget?: string;
    beneficiary?: string;
    tokenAddress?: string;
    milestones?: string;
    totalMismatch?: string;
  }>({});

  useEffect(() => {
    checkContractPauseStatus();
    checkNetworkStatus();
  }, [wallet.chainId]);

  const checkNetworkStatus = async () => {
    if (!wallet.isConnected) return;
    setIsOnCorrectNetwork(!wallet.chainId || wallet.chainId === ARC_CHAIN_ID);
  };

  const checkContractPauseStatus = async () => {
    try {
      const { contractService } = await import("@/lib/web3/contract-service");
      const health = await contractService.probeEscrowContractHealth();
      if (!health.ok) {
        setContractConfigError(health.userMessage);
        setIsContractPaused(true);
        return;
      }
      setContractConfigError(null);
      setIsContractPaused(health.jobCreationPaused);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Contract check failed.";
      setContractConfigError(msg);
      setIsContractPaused(true);
    }
  };

  const prefillFreelancer = searchParams.get("freelancer") ?? "";

  /**
   * A brief handed over from Autopilot's compose flow.
   *
   * Read from sessionStorage rather than the URL: a brief with several
   * milestones and a paragraph of criteria makes a URL long enough to be
   * truncated somewhere in the middle, and the failure would be a quietly
   * half-filled form rather than an error.
   *
   * Read once, in the initialiser, so editing a field and re-rendering does not
   * snap the form back to the agent's version. The key is cleared as soon as it
   * is read — a stale brief resurfacing on a later unrelated visit to this page
   * would be baffling.
   */
  const autopilotBrief = useMemo(() => {
    if (searchParams.get("from") !== "autopilot") return null;
    try {
      const raw = sessionStorage.getItem(AUTOPILOT_BRIEF_KEY);
      sessionStorage.removeItem(AUTOPILOT_BRIEF_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw) as {
        title?: string;
        instruction?: string;
        deliverableFormat?: string;
        criteria?: string[];
        durationDays?: number;
        budget?: number;
        milestones?: { description: string; amount: number }[];
      };
      if (!Array.isArray(b.milestones) || b.milestones.length === 0) return null;
      return b;
    } catch {
      return null;
    }
  }, [searchParams]);

  const [formData, setFormData] = useState({
    projectTitle: autopilotBrief?.title ?? "",
    projectDescription: autopilotBrief
      ? [
          autopilotBrief.instruction,
          autopilotBrief.deliverableFormat
            ? `Deliverable: ${autopilotBrief.deliverableFormat}`
            : "",
          autopilotBrief.criteria?.length
            ? `Acceptance criteria:\n${autopilotBrief.criteria.map((c) => `• ${c}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "",
    /* What kind of work this is. Written into the description as a marker the
       subgraph lifts into a queryable field, so the board can be filtered
       without spending a contract upgrade on a browsing aid. */
    category: "design" as CategoryId,
    /* Who pays the platform fee: the client up front, or the escrow's own
       earnings. Answered once here because the contract will not let it be
       answered again once a freelancer is on the job — see yield-choice.tsx. */
    yieldOptIn: false,
    duration: autopilotBrief?.durationDays ? String(autopilotBrief.durationDays) : "",
    totalBudget: autopilotBrief?.budget ? String(autopilotBrief.budget) : "",
    beneficiary: prefillFreelancer,
    // Default to native USDC, no external token needed
    token: "",
    useNativeToken: true,
    // An Autopilot job is posted openly — the agent's whole job is to read the
    // applications and pick someone.
    isOpenJob: autopilotBrief ? true : false,
    milestones: (autopilotBrief?.milestones
      ? autopilotBrief.milestones.map((m) => ({
          description: m.description,
          amount: String(m.amount),
        }))
      : [
          { description: "", amount: "" },
          { description: "", amount: "" },
        ]) as Milestone[],
  });

  const calculateTotalMilestones = () =>
    formData.milestones.reduce((sum, m) => sum + (Number.parseFloat(m.amount) || 0), 0);

  const validateStep = () => {
    const newErrors: typeof errors = {};
    let hasErrors = false;

    if (step === 1) {
      if (!formData.projectTitle || formData.projectTitle.length < 3) {
        newErrors.projectTitle = "Project title must be at least 3 characters";
        hasErrors = true;
      }
      if (!formData.projectDescription || formData.projectDescription.length < 50) {
        newErrors.projectDescription = "Project description must be at least 50 characters";
        hasErrors = true;
      }
      if (!formData.duration || Number(formData.duration) < 1 || Number(formData.duration) > 365) {
        newErrors.duration = "Duration must be between 1 and 365 days";
        hasErrors = true;
      }
      if (!formData.totalBudget || Number(formData.totalBudget) < 0.0001) {
        newErrors.totalBudget = "Total budget must be at least 0.0001 USDC";
        hasErrors = true;
      }
      if (!formData.isOpenJob && (!formData.beneficiary || !/^0x[a-fA-F0-9]{40}$/.test(formData.beneficiary))) {
        newErrors.beneficiary = "Valid Arc EVM address (0x…) required for direct escrow";
        hasErrors = true;
      }
      if (!formData.useNativeToken && !formData.token) {
        newErrors.tokenAddress = "Please select a whitelisted token or use native USDC";
        hasErrors = true;
      }
    } else if (step === 2) {
      const total = calculateTotalMilestones();
      const targetTotal = Number.parseFloat(formData.totalBudget) || 0;

      if (formData.milestones.some((m) => !m.description || !m.amount)) {
        newErrors.milestones = "Please fill in all milestone details";
        hasErrors = true;
      }
      if (Math.abs(total - targetTotal) > 0.0001) {
        newErrors.totalMismatch = `Milestone amounts (${total.toFixed(6)}) must equal total (${targetTotal.toFixed(6)})`;
        hasErrors = true;
      }
    }

    setErrors(newErrors);
    return !hasErrors;
  };

  const clearErrors = () => setErrors({});

  const nextStep = () => {
    if (validateStep()) setStep(step + 1);
  };

  const prevStep = () => setStep(step - 1);

  const validateForm = (): string[] => {
    const errs: string[] = [];

    if (!formData.projectTitle || formData.projectTitle.length < 3)
      errs.push("Project title must be at least 3 characters long");
    if (!formData.projectDescription || formData.projectDescription.length < 50)
      errs.push("Project description must be at least 50 characters long");
    if (!formData.duration || Number(formData.duration) < 1 || Number(formData.duration) > 365)
      errs.push("Duration must be between 1 and 365 days");
    if (!formData.totalBudget || Number(formData.totalBudget) < 0.0001)
      errs.push("Total budget must be at least 0.0001 USDC");
    if (!formData.useNativeToken && !formData.token)
      errs.push("Please select a whitelisted token");
    if (!formData.isOpenJob) {
      if (!formData.beneficiary)
        errs.push("Beneficiary address is required for direct escrow");
      else if (!/^0x[a-fA-F0-9]{40}$/.test(formData.beneficiary))
        errs.push("Beneficiary must be a valid Arc EVM address (0x…)");
    }
    if (formData.milestones.length === 0)
      errs.push("At least one milestone is required");

    for (let i = 0; i < formData.milestones.length; i++) {
      const m = formData.milestones[i];
      if (!m.description || m.description.length < 10)
        errs.push(`Milestone ${i + 1} description must be at least 10 characters`);
      if (!m.amount || Number(m.amount) < 0.0001)
        errs.push(`Milestone ${i + 1} amount must be at least 0.0001 USDC`);
    }

    const milestoneTotal = formData.milestones.reduce((s, m) => s + Number(m.amount || 0), 0);
    if (Math.abs(milestoneTotal - Number(formData.totalBudget)) > 0.0001)
      errs.push("Total milestone amounts must equal the total budget");

    return errs;
  };

  const handleSubmit = async () => {
    if (!wallet.isConnected) {
      toast({ title: "Wallet Not Connected", description: "Please connect your wallet to create a job", variant: "destructive" });
      return;
    }

    const validationErrors = validateForm();
    if (validationErrors.length > 0) {
      toast({ title: "Please Fix These Issues", description: validationErrors.join(", "), variant: "destructive" });
      return;
    }

    // Additional validation for amounts
    const totalBudgetNum = Number.parseFloat(formData.totalBudget || "0");
    if (totalBudgetNum <= 0) {
      toast({ title: "Invalid Amount", description: "Total budget must be greater than 0", variant: "destructive" });
      return;
    }

    const totalMilestones = formData.milestones.reduce((sum, m) => sum + Number.parseFloat(m.amount || "0"), 0);
    if (Math.abs(totalMilestones - totalBudgetNum) > 0.01) {
      toast({ title: "Amount Mismatch", description: "Milestone amounts must equal total budget", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);

    try {
      const milestoneDescriptions = formData.milestones.map((m) => m.description);

      const beneficiaryAddress = formData.isOpenJob
        ? undefined
        : (formData.beneficiary as `0x${string}`) || undefined;

      // Convert amounts to base units using the correct token decimals
      // Arc Testnet USDC is an ERC-20 token at 0x3600...0000, NOT native token
      // Always use USDC token address (it's an ERC-20, not native)
      const tokenAddr = USDC_ADDRESS || "0x3600000000000000000000000000000000000000";
      
      const totalAmountWei = parseTokenAmount(formData.totalBudget, tokenAddr);
      const milestoneAmountsWei = formData.milestones.map((m) =>
        parseTokenAmount(m.amount || "0", tokenAddr)
      );

      // Validate converted amounts
      if (totalAmountWei === 0n) {
        throw new Error("Total amount is 0. Please enter a valid amount.");
      }

      // Check USDC balance (wallet.balance shows USDC balance on Arc Testnet)
      const walletBalance = Number.parseFloat(wallet.balance || "0");
      const requiredBalance = Number.parseFloat(formData.totalBudget);
      if (walletBalance < requiredBalance) {
        throw new Error(
          `Insufficient USDC balance. You have ${walletBalance.toFixed(2)} USDC but need ${formData.totalBudget} USDC (plus a small platform fee).`
        );
      }

      const milestones = milestoneAmountsWei.map(
        (amount, idx) => [amount.toString(), milestoneDescriptions[idx] || ""] as [string, string]
      );

      if (!wallet.address) throw new Error("Wallet not connected");

      // For Arc Testnet USDC (ERC-20), pass the USDC token address
      // USDC is an ERC-20 token, not native ETH
      const tokenToPass = USDC_ADDRESS || "0x3600000000000000000000000000000000000000";

      /*
       * The fee choice has to be recorded BEFORE the escrow exists.
       *
       * It decides whether a platform fee is charged at all, and by the next
       * transaction the money has already moved — so this cannot be a
       * follow-up the way it was when the fee was charged either way. The
       * escrow consumes the flag as it creates the job.
       *
       * A failure here must stop the post rather than quietly charge the fee:
       * a client who chose to pay nothing and was charged anyway has been
       * overcharged, which is worse than not posting.
       */
      if (formData.yieldOptIn) {
        toast({
          title: "Putting your escrow to work",
          description: "Approve this first — it is what waives the platform fee.",
        });
        const { ContractService } = await import("@/lib/web3/contract-service");
        await new ContractService(CONTRACTS.ATELIER_ESCROW).setWorkIntent(
          true,
          writeContractAsync,
        );
      }

      toast({ 
        title: "Creating Escrow", 
        description: "Processing your job creation. This may take a minute. Please don't close this window." 
      });

      const result = await createEscrow.mutateAsync({
        depositor: wallet.address,
        beneficiary: beneficiaryAddress,
        arbiters: [],
        required_confirmations: 1,
        milestones,
        token: tokenToPass,
        total_amount: totalAmountWei.toString(),
        duration: Number(formData.duration) * 86400,
        project_title: formData.projectTitle,
        // The marker leads the description so the subgraph can lift it into a
        // queryable field, and the UI strips it before anyone reads it.
        project_description: `${categoryMarker(formData.category ?? "design")}\n${formData.projectDescription}`,
        // Set on the controller just above, and about to be consumed by the
        // escrow — so the approval must not ask for a fee that is being waived.
        put_to_work: formData.yieldOptIn,
      });

      toast({ 
        title: "Job Created Successfully", 
        description: result.escrowId !== "unknown"
          ? `Your job #${result.escrowId} has been created and is now live.`
          : "Your job has been created successfully and is now live."
      });

      setTimeout(() => {
        navigate(formData.isOpenJob ? "/jobs" : "/dashboard");
      }, 2000);
    } catch (error: any) {
      if (!createEscrow.isError) {
        toast({
          title: "Action failed",
          description: error?.message || "Something went wrong. Please try again.",
          variant: "destructive",
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  /*
   * The same gate as the Autopilot side, for the same reason.
   *
   * Creating an escrow is signed by the client's wallet, so without one this
   * page let somebody fill in a title, a budget, a deadline and every milestone
   * before a toast at submit told them it was never going to work. Ask first.
   *
   * Below every hook so the gate cannot change how many run.
   */
  if (!wallet.isConnected) {
    return (
      <div className="container mx-auto px-4 py-20 sm:py-28 max-w-lg text-center">
        <h1 className="font-display text-2xl sm:text-3xl font-bold">
          Connect a wallet to post a job
        </h1>
        <p className="text-muted-foreground mt-3 leading-relaxed">
          The budget is locked in the escrow contract when you post, funded from
          your wallet — so a freelancer can see the money is real before they
          apply. That needs a wallet connected.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center mt-8">
          <Button asChild variant="outline">
            <Link to="/jobs">Browse jobs instead</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/post">Back to modes</Link>
          </Button>
        </div>
      </div>
    );
  }


  return (
    <div className="min-h-screen py-12 gradient-mesh">
      {!isOnCorrectNetwork && wallet.isConnected && (
        <div className="container mx-auto px-4 max-w-4xl mb-6">
          <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
                <div>
                  <h3 className="font-semibold text-destructive">Wrong Network</h3>
                  <p className="text-sm text-muted-foreground">
                    Please switch your wallet to Arc Testnet (chain ID {ARC_CHAIN_ID})
                  </p>
                </div>
              </div>
              <Button onClick={() => window.location.reload()} variant="destructive" size="sm">
                Refresh
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="container mx-auto px-4 py-8 max-w-4xl">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          {contractConfigError && (
            <Alert variant="destructive" className="mb-8">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Escrow contract unavailable</AlertTitle>
              <AlertDescription>{contractConfigError}</AlertDescription>
            </Alert>
          )}

          <h1 className="text-4xl md:text-5xl font-bold mb-3 text-center">Create New Escrow</h1>
          <p className="text-xl text-muted-foreground text-center mb-10">
            Set up a secure escrow with milestone-based payments
          </p>

          <div className="flex items-center justify-center mb-10">
            <div className="flex items-center gap-4">
              {[1, 2, 3].map((s) => (
                <div key={s} className="flex items-center gap-4">
                  <div
                    className={`flex items-center justify-center w-10 h-10 rounded-full border-2 transition-all ${
                      s === step
                        ? "border-primary bg-primary text-primary-foreground"
                        : s < step
                          ? "border-primary bg-primary/20 text-primary"
                          : "border-muted-foreground/30 text-muted-foreground"
                    }`}
                  >
                    {s < step ? <CheckCircle2 className="h-5 w-5" /> : s}
                  </div>
                  {s < 3 && (
                    <div className={`w-16 h-0.5 ${s < step ? "bg-primary" : "bg-muted-foreground/30"}`} />
                  )}
                </div>
              ))}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {step === 1 && (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="mb-6"
              >
                <ProjectDetailsStep
                  formData={formData}
                  onUpdate={(data) => {
                    setFormData({ ...formData, ...data });
                    clearErrors();
                  }}
                  isContractPaused={isContractPaused}
                  errors={{
                    projectTitle: errors.projectTitle,
                    projectDescription: errors.projectDescription,
                    duration: errors.duration,
                    totalBudget: errors.totalBudget,
                    beneficiary: errors.beneficiary,
                    tokenAddress: errors.tokenAddress,
                  }}
                />
              </motion.div>
            )}

            {step === 2 && (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="mb-6"
              >
                <MilestonesStep
                  milestones={formData.milestones}
                  onUpdate={(milestones) => {
                    setFormData({ ...formData, milestones });
                    clearErrors();
                  }}
                  showAIWriter={showAIWriter}
                  onToggleAIWriter={setShowAIWriter}
                  currentMilestoneIndex={currentMilestoneIndex}
                  onSetCurrentMilestoneIndex={setCurrentMilestoneIndex}
                  totalBudget={formData.totalBudget}
                  projectTitle={formData.projectTitle}
                  projectDescription={formData.projectDescription}
                  durationDays={formData.duration}
                  errors={{ milestones: errors.milestones, totalMismatch: errors.totalMismatch }}
                />
              </motion.div>
            )}

            {step === 3 && (
              <motion.div
                key="step3"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3 }}
                className="mb-6"
              >
                <ReviewStep
                  formData={formData}
                  onConfirm={handleSubmit}
                  onYieldChange={(yieldOptIn) =>
                    setFormData((prev) => ({ ...prev, yieldOptIn }))
                  }
                  isSubmitting={isSubmitting || createEscrow.isPending}
                  isContractPaused={isContractPaused}
                  isOnCorrectNetwork={isOnCorrectNetwork}
                  walletBalance={wallet.balance}
                />
              </motion.div>
            )}
          </AnimatePresence>

          <div className="flex justify-between mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={prevStep}
              disabled={step === 1}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Previous
            </Button>

            <Button
              type="button"
              onClick={nextStep}
              disabled={step === 3 || !!contractConfigError}
              className="flex items-center gap-2"
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
