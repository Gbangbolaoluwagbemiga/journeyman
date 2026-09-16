import { useState } from "react";
import { useWriteContract } from "wagmi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useWeb3 } from "@/contexts/web3-context";
import { useNotifications } from "@/contexts/notification-context";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";
import { FileText, Upload, Loader2 } from "lucide-react";

interface EvidenceSubmissionButtonProps {
  escrowId: string;
  milestoneIndex: number;
  onEvidenceSubmitted?: () => void;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm" | "lg";
  className?: string;
  /** Wallet of the other party in this escrow — notified when evidence is submitted. */
  otherPartyAddress?: string;
  projectTitle?: string;
}

export function EvidenceSubmissionButton({
  escrowId,
  milestoneIndex,
  onEvidenceSubmitted,
  variant = "outline",
  size = "sm",
  className = "",
  otherPartyAddress,
  projectTitle,
}: EvidenceSubmissionButtonProps) {
  const { wallet } = useWeb3();
  const { addCrossWalletNotification } = useNotifications();
  const { toast } = useToast();
  const { writeContractAsync } = useWriteContract();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [evidenceCid, setEvidenceCid] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");

  const handleSubmitEvidence = async () => {
    if (!evidenceCid.trim()) {
      toast({
        title: "Evidence required",
        description: "Please enter an IPFS CID or evidence link",
        variant: "destructive",
      });
      return;
    }

    setSubmitting(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);

      // Combine CID and description if description exists
      const fullCid = evidenceDescription 
        ? `${evidenceCid}|${evidenceDescription}` 
        : evidenceCid;

      await svc.submitEvidence(
        {
          escrow_id: Number(escrowId),
          milestone_index: milestoneIndex,
          cid: fullCid,
          submitter: wallet.address || "",
        },
        writeContractAsync
      );

      toast({
        title: "Evidence submitted!",
        description: "Your evidence has been recorded on-chain",
      });

      if (otherPartyAddress) {
        const title = projectTitle || `Escrow #${escrowId}`;
        addCrossWalletNotification(
          {
            type: "dispute",
            title: "New Evidence Submitted",
            message: `New evidence was submitted for milestone ${milestoneIndex + 1} of "${title}". Review it before the arbiter decides.`,
            actionUrl: `/dashboard?job=${escrowId}`,
            data: {
              escrowId: Number(escrowId),
              milestoneIndex,
              action: "evidence_submitted",
            },
          },
          undefined,
          otherPartyAddress,
        );
      }

      setEvidenceCid("");
      setEvidenceDescription("");
      setDialogOpen(false);
      onEvidenceSubmitted?.();
    } catch (error: any) {
      toast({
        title: "Failed to submit evidence",
        description: error?.message || "Something went wrong",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          <FileText className="mr-2 h-4 w-4" />
          Submit Evidence
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Submit Evidence</DialogTitle>
          <DialogDescription>
            Upload evidence to support your case in this dispute
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="evidenceCid">Evidence Link or IPFS CID</Label>
            <Input
              id="evidenceCid"
              placeholder="QmXxx... or https://..."
              value={evidenceCid}
              onChange={(e) => setEvidenceCid(e.target.value)}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Upload files to IPFS (Pinata, NFT.Storage) and paste the CID, or provide a direct link
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="evidenceDescription">Description (Optional)</Label>
            <Textarea
              id="evidenceDescription"
              placeholder="Explain what this evidence shows..."
              value={evidenceDescription}
              onChange={(e) => setEvidenceDescription(e.target.value)}
              rows={3}
            />
          </div>

          <div className="bg-muted/50 p-3 rounded-lg text-xs space-y-1">
            <p className="font-semibold">IPFS Upload Services:</p>
            <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
              <li><a href="https://pinata.cloud" target="_blank" rel="noopener noreferrer" className="underline">Pinata.cloud</a> - Free IPFS pinning</li>
              <li><a href="https://nft.storage" target="_blank" rel="noopener noreferrer" className="underline">NFT.Storage</a> - Free permanent storage</li>
              <li>Or use any direct URL to your evidence</li>
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmitEvidence}
            disabled={submitting || !evidenceCid.trim()}
          >
            {submitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Submit Evidence
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
