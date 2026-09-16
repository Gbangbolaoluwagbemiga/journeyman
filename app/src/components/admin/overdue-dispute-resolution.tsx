import { encodeJobId } from "@/lib/id-codec";
import { useState, useEffect, useCallback } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { useNotifications } from "@/contexts/notification-context";
import { CONTRACTS } from "@/lib/web3/config";
import { AlertTriangle, Scale, CheckCircle, Undo2, Clock, ChevronDown, ChevronUp } from "lucide-react";
import { motion } from "framer-motion";

interface OverdueCase {
  escrowId: string;
  projectTitle: string;
  clientAddress: string;
  freelancerAddress: string;
  requesterAddress: string;
  reason: string;
  requestedAt: number;
  totalAmount: number;
  paidAmount: number;
  unreleased: number;
}

interface Props {
  onResolved?: () => void;
}

export function OverdueDisputeResolution({ onResolved }: Props) {
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const { addNotification } = useNotifications();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const [cases, setCases] = useState<OverdueCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OverdueCase | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  /** 0 = full refund to client; 100 = full award to freelancer */
  const [freelancerPct, setFreelancerPct] = useState(0);
  const [freelancerPctInput, setFreelancerPctInput] = useState("0");
  
  // Pagination and filtering
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "amount">("newest");
  const [isExpanded, setIsExpanded] = useState(true);

  const fetchCases = useCallback(async () => {
    if (!wallet.address) return;
    setLoading(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);
      const nextId = await svc.getNextEscrowId();
      const found: OverdueCase[] = [];

      const ids = Array.from({ length: Math.max(0, nextId - 1) }, (_, k) => k + 1);
      const escrowBatch = await svc.getEscrowsBatch(ids);

      for (const i of ids) {
        try {
          const escrow = escrowBatch[i];
          // Only show Disputed (4) escrows where deadline has passed
          if (!escrow || escrow.status !== 4) continue;
          const nowSecs = Math.floor(Date.now() / 1000);
          if (Number(escrow.deadline) > nowSecs) continue;

          const totalNum = Number(escrow.totalAmount ?? 0);
          const paidNum = Number(escrow.paidAmount ?? 0);
          found.push({
            escrowId: i.toString(),
            projectTitle: escrow.projectTitle || `Project #${i}`,
            clientAddress: escrow.depositor || "",
            freelancerAddress: escrow.beneficiary || "",
            requesterAddress: escrow.depositor || "",
            reason: "Overdue dispute",
            requestedAt: nowSecs,
            totalAmount: totalNum / 1e18,
            paidAmount: paidNum / 1e18,
            unreleased: (totalNum - paidNum) / 1e18,
          });
        } catch {
          // escrow may not exist
        }
      }
      setCases(found);
    } catch (err) {
    } finally {
      setLoading(false);
    }
  }, [wallet.address]);

  useEffect(() => {
    void fetchCases();
  }, [fetchCases]);

  const openDialog = (c: OverdueCase) => {
    setSelected(c);
    setFreelancerPct(0);
    setFreelancerPctInput("0");
    setDialogOpen(true);
  };

  const handleResolve = async (fullRefundToClient: boolean) => {
    if (!selected || !wallet.address) return;
    setResolving(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);
      const unreleasedWei = BigInt(Math.round(selected.unreleased * 1e6)); // Convert to 6 decimals

      // Validate amounts
      if (unreleasedWei === 0n) {
        throw new Error("No unreleased funds to distribute. Cannot resolve dispute with 0 funds.");
      }

      toast({ title: "Submitting transaction...", description: "Please wait for confirmation" });

      let txHash: `0x${string}`;

      if (fullRefundToClient) {
        txHash = await svc.arbiterApproveRefund(
          { escrow_id: Number(selected.escrowId), arbiter: wallet.address || "" },
          writeContractAsync
        );
      } else {
        const pct = Math.min(Math.max(freelancerPct, 0), 100);
        const freelancerWei = (unreleasedWei * BigInt(pct)) / BigInt(100);
        const clientWei = unreleasedWei - freelancerWei;

        // Validate split
        if (freelancerWei + clientWei !== unreleasedWei) {
          throw new Error("Amount calculation error: freelancer + client amount does not equal total");
        }

        txHash = await svc.arbiterAwardFreelancer(
          {
            escrow_id: Number(selected.escrowId),
            arbiter: wallet.address || "",
            freelancer_amount: freelancerWei,
            reason: `Arbiter split: freelancer ${pct}% / client ${100 - pct}% of unreleased funds`,
          },
          writeContractAsync
        );
      }

      toast({ title: "Transaction sent", description: "Waiting for blockchain confirmation..." });

      // Wait for transaction to be mined and confirmed
      if (!publicClient) {
        throw new Error("Public client not available");
      }
      
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations: 1,
      });

      // Check if transaction was successful
      if (receipt.status === "reverted") {
        throw new Error("Transaction failed on-chain. The contract rejected the transaction.");
      }

      // Only show success and send notifications if transaction was confirmed
      if (fullRefundToClient) {
        toast({
          title: "Refund approved",
          description: `Full refund of ${selected.unreleased.toFixed(2)} USDC sent to client`,
        });
        // Notify client
        addNotification(
          {
            type: "escrow",
            title: "Arbitration: Full Refund",
            message: `An arbiter approved a full refund for "${selected.projectTitle}"`,
            actionUrl: `/dashboard?escrow=${selected.escrowId}`,
            data: { escrowId: selected.escrowId },
          },
          [selected.clientAddress],
        );
        // Notify freelancer
        addNotification(
          {
            type: "escrow",
            title: "Arbitration Decision",
            message: `An arbiter ruled in favour of the client on "${selected.projectTitle}"`,
            actionUrl: `/freelancer?escrow=${selected.escrowId}`,
            data: { escrowId: selected.escrowId },
          },
          [selected.freelancerAddress],
        );
      } else {
        const pct = Math.min(Math.max(freelancerPct, 0), 100);
        const freelancerWei = (unreleasedWei * BigInt(pct)) / BigInt(100);
        const freelancerAmt = Number(freelancerWei) / 1e6;
        const clientAmt = selected.unreleased - freelancerAmt;
        toast({
          title: "Award applied",
          description: `${freelancerAmt.toFixed(6)} USDC to freelancer, ${clientAmt.toFixed(6)} USDC returned to client`,
        });
        addNotification(
          {
            type: "escrow",
            title: "Arbitration: Award",
            message: `Arbiter awarded ${freelancerAmt.toFixed(6)} USDC to you for "${selected.projectTitle}"`,
            actionUrl: `/freelancer?escrow=${selected.escrowId}`,
            data: { escrowId: selected.escrowId },
          },
          [selected.freelancerAddress],
        );
        addNotification(
          {
            type: "escrow",
            title: "Arbitration Decision",
            message: `${clientAmt.toFixed(6)} USDC returned to you, ${freelancerAmt.toFixed(6)} USDC awarded to freelancer`,
            actionUrl: `/dashboard?escrow=${selected.escrowId}`,
            data: { escrowId: selected.escrowId },
          },
          [selected.clientAddress],
        );
      }

      setDialogOpen(false);
      setSelected(null);
      await fetchCases();
      onResolved?.();
    } catch (err: any) {
      // Better error messages for common failures
      let errorMessage = err.message || "Transaction failed";
      
      if (errorMessage.includes("Unauthorized") || errorMessage.includes("unauthorized")) {
        errorMessage = "You are not authorized as an arbiter. Ask the contract owner to authorize your address in Arbiter Management.";
      } else if (errorMessage.includes("InsufficientFunds") || errorMessage.includes("E2b42800")) {
        errorMessage = "Insufficient funds in escrow to complete this resolution. Check the escrow balance.";
      } else if (errorMessage.includes("User rejected") || errorMessage.includes("User denied")) {
        errorMessage = "Transaction was rejected by user";
      } else if (errorMessage.includes("reverted")) {
        errorMessage = "Transaction failed on-chain. The contract rejected the transaction.";
      }
      
      toast({
        title: "Resolution failed",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setResolving(false);
    }
  };

  if (loading) {
    return (
      <Card className="glass border-primary/20 p-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="h-4 w-4 animate-spin" />
          <span>Loading overdue disputes…</span>
        </div>
      </Card>
    );
  }

  // Sort cases
  const sortedCases = [...cases].sort((a, b) => {
    switch (sortBy) {
      case "newest":
        return b.requestedAt - a.requestedAt;
      case "oldest":
        return a.requestedAt - b.requestedAt;
      case "amount":
        return b.unreleased - a.unreleased;
      default:
        return 0;
    }
  });

  // Paginate cases
  const totalPages = Math.ceil(sortedCases.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedCases = sortedCases.slice(startIndex, endIndex);

  return (
    <div className="space-y-4">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <Card className="glass border-primary/20 p-6">
          <CollapsibleTrigger asChild>
            <div className="flex items-center justify-between cursor-pointer hover:opacity-80 transition-opacity mb-4">
              <div className="flex items-center gap-2">
                <Scale className="h-5 w-5 text-orange-500" />
                <h3 className="text-lg font-semibold">Overdue Disputes</h3>
                {cases.length > 0 && (
                  <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200">
                    {cases.length}
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent>
            {cases.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 mb-4 pb-4 border-b">
                <div className="flex items-center gap-2">
                  <Label className="text-sm">Sort by:</Label>
                  <Select value={sortBy} onValueChange={(v: any) => setSortBy(v)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="newest">Newest</SelectItem>
                      <SelectItem value="oldest">Oldest</SelectItem>
                      <SelectItem value="amount">Amount</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-2">
                  <Label className="text-sm">Per page:</Label>
                  <Select value={itemsPerPage.toString()} onValueChange={(v) => {
                    setItemsPerPage(Number(v));
                    setCurrentPage(1);
                  }}>
                    <SelectTrigger className="w-20">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5</SelectItem>
                      <SelectItem value="10">10</SelectItem>
                      <SelectItem value="25">25</SelectItem>
                      <SelectItem value="50">50</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Button variant="ghost" size="sm" onClick={() => void fetchCases()} className="ml-auto">
                  Refresh
                </Button>
              </div>
            )}

            {cases.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle className="h-10 w-10 mx-auto mb-3 text-green-500 opacity-60" />
                <p className="text-muted-foreground">No overdue disputes pending</p>
              </div>
            ) : (
              <>
                <div className="space-y-3">
                  {paginatedCases.map((c, i) => (
                    <motion.div
                      key={c.escrowId}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <Card className="glass border-orange-300/40 dark:border-orange-700/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-2 min-w-0">
                            <AlertTriangle className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                              <p className="font-medium truncate">{c.projectTitle}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {encodeJobId(c.escrowId)} · Raised by{" "}
                                <span className="font-mono">
                                  {c.requesterAddress.slice(0, 6)}…
                                  {c.requesterAddress.slice(-4)}
                                </span>
                              </p>
                              {c.reason && (
                                <p className="text-xs mt-1 text-gray-600 dark:text-gray-400 line-clamp-2">
                                  "{c.reason}"
                                </p>
                              )}
                              <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                                <span>
                                  Unreleased:{" "}
                                  <strong className="text-foreground">
                                    {c.unreleased.toFixed(2)} USDC
                                  </strong>
                                </span>
                                <span>
                                  Paid: {c.paidAmount.toFixed(2)} /{" "}
                                  {c.totalAmount.toFixed(2)} USDC
                                </span>
                              </div>
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0 border-orange-300 dark:border-orange-700 text-orange-700 dark:text-orange-400"
                            onClick={() => openDialog(c)}
                          >
                            Resolve
                          </Button>
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">
                      Showing {startIndex + 1}-{Math.min(endIndex, cases.length)} of {cases.length} cases
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                        disabled={currentPage === 1}
                      >
                        Previous
                      </Button>
                      <span className="text-sm">
                        Page {currentPage} of {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                        disabled={currentPage === totalPages}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Resolution dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="glass-thick max-w-lg">
          <DialogHeader>
            <DialogTitle>Resolve Overdue Dispute</DialogTitle>
            <DialogDescription>
              {selected?.projectTitle} — {selected?.unreleased.toFixed(2)} USDC
              unreleased
            </DialogDescription>
          </DialogHeader>

          {selected && (
            <div className="space-y-5 py-2">
              <div className="rounded-lg bg-muted/30 p-3 text-sm space-y-1">
                <p>
                  <span className="text-muted-foreground">Client: </span>
                  <span className="font-mono text-xs">
                    {selected.clientAddress.slice(0, 8)}…
                    {selected.clientAddress.slice(-6)}
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Freelancer: </span>
                  <span className="font-mono text-xs">
                    {selected.freelancerAddress.slice(0, 8)}…
                    {selected.freelancerAddress.slice(-6)}
                  </span>
                </p>
                <p className="mt-1 text-gray-600 dark:text-gray-400">
                  "{selected.reason}"
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium">
                  Freelancer's share (%){" "}
                  <span className="font-normal text-muted-foreground">
                    — remainder goes to client
                  </span>
                </Label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={freelancerPctInput}
                    onChange={(e) => {
                      setFreelancerPctInput(e.target.value);
                      const n = Math.min(
                        Math.max(parseInt(e.target.value) || 0, 0),
                        100,
                      );
                      setFreelancerPct(n);
                    }}
                    className="w-24"
                  />
                  <div className="flex-1 text-sm text-muted-foreground">
                    ≈{" "}
                    <strong className="text-foreground">
                      {((selected.unreleased * freelancerPct) / 100).toFixed(2)}{" "}
                      USDC
                    </strong>{" "}
                    to freelancer ·{" "}
                    <strong className="text-foreground">
                      {(
                        selected.unreleased -
                        (selected.unreleased * freelancerPct) / 100
                      ).toFixed(2)}{" "}
                      USDC
                    </strong>{" "}
                    to client
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={resolving}
            >
              Cancel
            </Button>
            {/* Full refund to client */}
            <Button
              variant="outline"
              className="border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-400"
              disabled={resolving}
              onClick={() => void handleResolve(true)}
            >
              <Undo2 className="h-4 w-4 mr-1.5" />
              Full Refund to Client
            </Button>
            {/* Split / award to freelancer */}
            <Button
              variant="destructive"
              disabled={resolving}
              onClick={() => void handleResolve(false)}
            >
              <Scale className="h-4 w-4 mr-1.5" />
              {resolving ? "Processing…" : "Apply Award"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
