import { useState, useEffect } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { useSignMessage } from "wagmi";
import { saveDisputeResolutionNote } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";
import { useNotifications } from "@/contexts/notification-context";
import { AlertTriangle, Clock, User, DollarSign, Scale, CheckCircle, ChevronDown, ChevronUp } from "lucide-react";
import { motion } from "framer-motion";
import { formatUnits } from "viem";
import { DisputeEvidence } from "./dispute-evidence";
import { AdminDisputeCommunication } from "./admin-dispute-communication";

interface Dispute {
  escrowId: string;
  milestoneIndex: number;
  disputedBy: string;
  disputeReason: string;
  disputedAt: number;
  milestoneAmountWei: bigint;
  milestoneAmountEth: number;
  clientAddress: string;
  freelancerAddress: string;
  projectTitle: string;
  milestoneDescription: string;
}

interface DisputeResolutionProps {
  onDisputeResolved: () => void;
}

export function DisputeResolution({ onDisputeResolved }: DisputeResolutionProps) {
  const { wallet } = useWeb3();
  const { signMessageAsync } = useSignMessage();
  const { toast } = useToast();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  const { addCrossWalletNotification } = useNotifications();
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDispute, setSelectedDispute] = useState<Dispute | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [freelancerPct, setFreelancerPct] = useState(50);
  const [resolutionReason, setResolutionReason] = useState("");
  
  // Pagination and filtering
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "amount">("newest");
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (wallet.isConnected) void fetchDisputes();
  }, [wallet.isConnected]);

  const fetchDisputes = async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);
      const nextId = await svc.getNextEscrowId();
      const found: Dispute[] = [];

      const ids = Array.from({ length: Math.max(0, nextId - 1) }, (_, k) => k + 1);
      const [escrowBatch, milestonesBatch] = await Promise.all([
        svc.getEscrowsBatch(ids),
        svc.getMilestonesBatch(ids),
      ]);

      for (const id of ids) {
        try {
          const escrow = escrowBatch[id];
          if (!escrow || escrow.status !== 4 /* Disputed */) continue;

          const milestones: any[] = milestonesBatch[id] ?? [];
          milestones.forEach((m, idx) => {
            if (Number(m.status) === 4 /* MilestoneStatus.Disputed */) {
              // Calculate remaining amount at stake (total - already paid)
              const escrowTotalWei = BigInt(escrow.totalAmount ?? 0);
              const escrowPaidWei = BigInt(escrow.paidAmount ?? 0);
              const remainingWei = escrowTotalWei - escrowPaidWei;
              
              // Use milestone amount if available, otherwise use remaining escrow balance
              const milestoneAmtWei = BigInt(m.amount ?? 0);
              let amtWei = milestoneAmtWei > 0n ? milestoneAmtWei : remainingWei;
              
              // FALLBACK: If still 0, use total escrow amount (ignore paidAmount)
              if (amtWei === 0n && escrowTotalWei > 0n) {
                amtWei = escrowTotalWei;
              }
              
              // USDC uses 6 decimals on Arc Testnet
              const displayAmount = Number(formatUnits(amtWei, 6));
              
              found.push({
                escrowId: id.toString(),
                milestoneIndex: idx,
                disputedBy: m.disputedBy ?? "",
                disputeReason: m.disputeReason ?? "",
                disputedAt: Number(m.disputedAt ?? 0),
                milestoneAmountWei: amtWei,
                milestoneAmountEth: displayAmount,
                clientAddress: escrow.depositor,
                freelancerAddress: escrow.beneficiary,
                projectTitle: escrow.projectTitle || `Project #${id}`,
                // `requirements` is the original client brief, set once at creation and
                // never overwritten. `description` gets overwritten by the freelancer's
                // submission text, so it must never be shown to the arbiter as "the milestone".
                milestoneDescription: m.requirements || m.description || "",
              });
            }
          });
        } catch {
          /* skip non-existent escrows */
        }
      }
      setDisputes(found);
    } catch {
      toast({ title: "Error", description: "Failed to fetch disputes", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const openDialog = (dispute: Dispute) => {
    setSelectedDispute(dispute);
    setFreelancerPct(50);
    setResolutionReason("");
    setDialogOpen(true);
  };

  const resolveDispute = async () => {
    if (!selectedDispute) return;
    setIsResolving(true);
    try {
      const { ContractService } = await import("@/lib/web3/contract-service");
      const svc = new ContractService(CONTRACTS.ATELIER_ESCROW);
      const total = selectedDispute.milestoneAmountWei;
      const freelancerAmount = (total * BigInt(freelancerPct)) / 100n;
      const clientAmount = total - freelancerAmount;

      // Validate amounts before sending
      if (total === 0n) {
        throw new Error("Milestone amount is 0. Cannot resolve dispute with 0 funds.");
      }

      if (freelancerAmount + clientAmount !== total) {
        throw new Error("Amount calculation error: freelancer + client amount does not equal total");
      }

      toast({ title: "Submitting transaction...", description: "Please wait for confirmation" });

      // Send transaction and get hash
      const txHash = await svc.arbiterAwardFreelancer(
        { escrow_id: Number(selectedDispute.escrowId), arbiter: wallet.address || "", freelancer_amount: freelancerAmount, reason: resolutionReason },
        writeContractAsync
      );

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
      toast({ title: "Dispute Resolved", description: "Resolution confirmed on-chain." });

      /*
       * PUT THE REASONING SOMEWHERE BOTH SIDES CAN READ IT.
       *
       * Below, this was written to localStorage — on this machine, belonging to
       * whoever happened to resolve it — and the contract's DisputeResolved
       * event carries the amounts but not the words. So the freelancer whose
       * payment had just been decided could never read why, from any device.
       *
       * After the transaction, because only a resolution that actually landed
       * has a reason worth recording, and the backend verifies the signer
       * against the on-chain event. Not fatal: the money has already moved, and
       * failing the whole action here would tell an arbiter their ruling did
       * not go through when it did.
       */
      if (resolutionReason.trim() && wallet.address) {
        try {
          await saveDisputeResolutionNote({
            escrowId: selectedDispute.escrowId,
            milestoneIndex: Number(selectedDispute.milestoneIndex),
            arbiter: wallet.address,
            reason: resolutionReason.trim(),
            /* Written with the reason so the record of the decision is one row,
               not a row plus a log scan that stops finding the amounts. */
            freelancerAmount: Number(freelancerAmount),
            clientAmount: Number(clientAmount),
            signMessageAsync,
          });
        } catch (e) {
          toast({
            title: "Resolution recorded on-chain",
            description: `Your written reason could not be saved (${e instanceof Error ? e.message : "unknown error"}), so only the amounts are visible to both sides.`,
          });
        }
      }
      
      // Dispatch event for dispute resolved
      window.dispatchEvent(new CustomEvent("disputeResolved", {
        detail: {
          escrowId: selectedDispute.escrowId,
          milestoneIndex: selectedDispute.milestoneIndex,
          clientAddress: selectedDispute.clientAddress,
          freelancerAddress: selectedDispute.freelancerAddress,
          freelancerAmount: freelancerAmount.toString(),
          clientAmount: clientAmount.toString(),
          reason: resolutionReason,
        }
      }));
      
      // Send notification to client
      addCrossWalletNotification(
        {
          type: "dispute",
          title: "Dispute Resolved by Arbiter",
          message: `Dispute #${selectedDispute.escrowId} resolved. Reason: ${resolutionReason || "No reason provided"}`,
          actionUrl: `/dashboard?escrow=${selectedDispute.escrowId}`,
          data: { escrowId: selectedDispute.escrowId },
        },
        selectedDispute.clientAddress
      );
      
      // Send notification to freelancer
      addCrossWalletNotification(
        {
          type: "dispute",
          title: "Dispute Resolved by Arbiter",
          message: `Dispute #${selectedDispute.escrowId} resolved. Reason: ${resolutionReason || "No reason provided"}`,
          actionUrl: `/freelancer?escrow=${selectedDispute.escrowId}`,
          data: { escrowId: selectedDispute.escrowId },
        },
        selectedDispute.freelancerAddress
      );

      setDialogOpen(false);
      setSelectedDispute(null);
      await fetchDisputes(false);
      onDisputeResolved();
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
        title: "Resolution Failed", 
        description: errorMessage, 
        variant: "destructive" 
      });
    } finally {
      setIsResolving(false);
    }
  };

  const getDisputeAge = (ts: number) => {
    const secs = Math.floor(Date.now() / 1000) - ts;
    const days = Math.floor(secs / 86400);
    const hrs = Math.floor(secs / 3600);
    if (days > 0) return `${days}d ago`;
    if (hrs > 0) return `${hrs}h ago`;
    return "Just now";
  };

  // Sort disputes
  const sortedDisputes = [...disputes].sort((a, b) => {
    switch (sortBy) {
      case "newest":
        return b.disputedAt - a.disputedAt;
      case "oldest":
        return a.disputedAt - b.disputedAt;
      case "amount":
        return Number(b.milestoneAmountWei - a.milestoneAmountWei);
      default:
        return 0;
    }
  });

  // Paginate disputes
  const totalPages = Math.ceil(sortedDisputes.length / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const endIndex = startIndex + itemsPerPage;
  const paginatedDisputes = sortedDisputes.slice(startIndex, endIndex);

  const freelancerEth = selectedDispute ? (selectedDispute.milestoneAmountEth * freelancerPct) / 100 : 0;
  const clientEth = selectedDispute ? selectedDispute.milestoneAmountEth - freelancerEth : 0;

  if (loading) {
    return (
      <Card className="glass border-primary/20 p-6">
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <span className="ml-3">Loading disputes…</span>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <Card className="glass border-primary/20 p-6">
          <CollapsibleTrigger asChild>
            <div className="flex items-center gap-3 mb-4 cursor-pointer hover:opacity-80 transition-opacity">
              <Scale className="h-6 w-6 text-primary" />
              <h2 className="text-2xl font-bold">Dispute Resolution</h2>
              <Badge variant="outline" className="ml-auto">{disputes.length} Active</Badge>
              {isExpanded ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
            </div>
          </CollapsibleTrigger>

          <CollapsibleContent>
            {disputes.length > 0 && (
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

                <Button onClick={() => void fetchDisputes(false)} variant="outline" size="sm" className="ml-auto">
                  Refresh
                </Button>
              </div>
            )}

            {disputes.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500" />
                <p className="text-lg">No active disputes</p>
                <p className="text-sm">All escrows are running smoothly</p>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  {paginatedDisputes.map((d, i) => (
                    <motion.div
                      key={`${d.escrowId}-${d.milestoneIndex}`}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.05 }}
                    >
                      <Card className="border-red-200 bg-red-100/80 dark:bg-red-900/20 p-4">
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-2">
                              <AlertTriangle className="h-4 w-4 text-red-500" />
                              <span className="font-semibold text-red-700 dark:text-red-400">Dispute #{d.escrowId}</span>
                              <Badge variant="destructive">Milestone {d.milestoneIndex}</Badge>
                            </div>
                            <p className="text-sm text-muted-foreground mb-1">{d.projectTitle}</p>
                            <p className="text-sm mb-1"><strong>Reason:</strong> {d.disputeReason}</p>
                            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground mt-2">
                              <span className="flex items-center gap-1"><User className="h-3 w-3" />Client: {d.clientAddress.slice(0, 6)}…{d.clientAddress.slice(-4)}</span>
                              <span className="flex items-center gap-1"><User className="h-3 w-3" />Freelancer: {d.freelancerAddress.slice(0, 6)}…{d.freelancerAddress.slice(-4)}</span>
                              <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />{d.milestoneAmountEth.toFixed(6)} USDC</span>
                              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{getDisputeAge(d.disputedAt)}</span>
                            </div>
                          </div>
                          <Button onClick={() => openDialog(d)} className="ml-4 shrink-0">Resolve</Button>
                        </div>
                      </Card>
                    </motion.div>
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="flex items-center justify-between mt-6 pt-4 border-t">
                    <p className="text-sm text-muted-foreground">
                      Showing {startIndex + 1}-{Math.min(endIndex, disputes.length)} of {disputes.length} disputes
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Resolve Dispute</DialogTitle>
            <DialogDescription>Review evidence and set the fund split between client and freelancer.</DialogDescription>
          </DialogHeader>

          {selectedDispute && (
            <Tabs defaultValue="details" className="space-y-4">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="details">Dispute Details</TabsTrigger>
                <TabsTrigger value="communication">Evidence & Messages</TabsTrigger>
              </TabsList>

              {/* Dispute Details Tab */}
              <TabsContent value="details" className="space-y-5">
                <div className="bg-muted/50 p-4 rounded-lg text-sm space-y-1">
                  <p><strong>Project:</strong> {selectedDispute.projectTitle}</p>
                  <p><strong>Milestone:</strong> {selectedDispute.milestoneDescription}</p>
                  <p><strong>Dispute Reason:</strong> {selectedDispute.disputeReason}</p>
                  <p><strong>Total at stake:</strong> {selectedDispute.milestoneAmountEth.toFixed(6)} USDC</p>
                  <p><strong>Client:</strong> <span className="font-mono text-xs">{selectedDispute.clientAddress}</span></p>
                  <p><strong>Freelancer:</strong> <span className="font-mono text-xs">{selectedDispute.freelancerAddress}</span></p>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span>Client gets: {clientEth.toFixed(6)} USDC</span>
                    <span>Freelancer gets: {freelancerEth.toFixed(6)} USDC</span>
                  </div>
                  <Slider value={[freelancerPct]} onValueChange={([v]) => setFreelancerPct(v)} min={0} max={100} step={1} />
                  <p className="text-xs text-muted-foreground text-center">Freelancer's share: {freelancerPct}%</p>
                  <div className="grid grid-cols-3 gap-2">
                    <Button variant="outline" size="sm" onClick={() => setFreelancerPct(0)}>All to Client</Button>
                    <Button variant="outline" size="sm" onClick={() => setFreelancerPct(50)}>50 / 50</Button>
                    <Button variant="outline" size="sm" onClick={() => setFreelancerPct(100)}>All to Freelancer</Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Resolution Reason (required)</Label>
                  <Input 
                    value={resolutionReason} 
                    onChange={(e) => setResolutionReason(e.target.value)} 
                    placeholder="Explain your decision…" 
                    required
                  />
                  {!resolutionReason.trim() && (
                    <p className="text-xs text-red-600">Resolution reason is required</p>
                  )}
                </div>
              </TabsContent>

              {/* Evidence & Messages Tab */}
              <TabsContent value="communication" className="space-y-4">
                {/* Evidence Thread */}
                <DisputeEvidence
                  escrowId={selectedDispute.escrowId}
                  milestoneIndex={selectedDispute.milestoneIndex}
                  clientAddress={selectedDispute.clientAddress}
                  freelancerAddress={selectedDispute.freelancerAddress}
                />
                
                {/* Admin Communication */}
                <AdminDisputeCommunication
                  escrowId={selectedDispute.escrowId}
                  milestoneIndex={selectedDispute.milestoneIndex}
                  clientAddress={selectedDispute.clientAddress}
                  freelancerAddress={selectedDispute.freelancerAddress}
                  projectTitle={selectedDispute.projectTitle}
                />
              </TabsContent>
            </Tabs>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => void resolveDispute()} 
              disabled={isResolving || !resolutionReason.trim()} 
              className="bg-green-600 hover:bg-green-700"
            >
              {isResolving ? "Resolving…" : "Resolve Dispute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
