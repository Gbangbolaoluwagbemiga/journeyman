import { encodeJobId } from "@/lib/id-codec";
import { useState, useEffect } from "react";
import { useWriteContract, usePublicClient } from "wagmi";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { CONTRACTS } from "@/lib/web3/config";
import { FileText, Upload, ExternalLink, User, Clock, Loader2, MessageSquare } from "lucide-react";
import { motion } from "framer-motion";
import { parseAbiItem } from "viem";

interface EvidenceEntry {
  escrowId: string;
  milestoneIndex: number;
  submitter: string;
  cid: string;
  timestamp: number;
  blockNumber: number;
}

interface DisputeEvidenceProps {
  escrowId: string;
  milestoneIndex: number;
  clientAddress: string;
  freelancerAddress: string;
  onEvidenceSubmitted?: () => void;
}

export function DisputeEvidence({
  escrowId,
  milestoneIndex,
  clientAddress,
  freelancerAddress,
  onEvidenceSubmitted,
}: DisputeEvidenceProps) {
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
  
  const [evidence, setEvidence] = useState<EvidenceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [evidenceCid, setEvidenceCid] = useState("");
  const [evidenceDescription, setEvidenceDescription] = useState("");

  useEffect(() => {
    void fetchEvidence();
  }, [escrowId, milestoneIndex]); // Only refetch when escrow/milestone changes, not on every block

  const fetchEvidence = async () => {
    setLoading(true);
    try {
      if (!publicClient) return;

      // Get current block number
      const currentBlock = await publicClient.getBlockNumber();
      
      // Arc Testnet RPC limit: max 10000 blocks per query
      // Search last 9000 blocks to stay under limit
      const fromBlock = currentBlock > 9000n ? currentBlock - 9000n : 0n;

      // Fetch EvidenceSubmitted events for this escrow and milestone
      const logs = await publicClient.getLogs({
        address: CONTRACTS.ATELIER_ESCROW as `0x${string}`,
        event: parseAbiItem('event EvidenceSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed submitter, string cid)'),
        args: {
          escrowId: BigInt(escrowId),
          milestoneIndex: BigInt(milestoneIndex),
        },
        fromBlock: fromBlock,
        toBlock: 'latest',
      });

      const entries: EvidenceEntry[] = [];
      for (const log of logs) {
        const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
        entries.push({
          escrowId: escrowId,
          milestoneIndex: milestoneIndex,
          submitter: log.args.submitter as string,
          cid: log.args.cid as string,
          timestamp: Number(block.timestamp),
          blockNumber: Number(log.blockNumber),
        });
      }

      // Sort by timestamp (oldest first)
      entries.sort((a, b) => a.timestamp - b.timestamp);
      setEvidence(entries);
    } catch (error) {
      console.error("Failed to fetch evidence:", error);
      // Don't show error to user, just show empty state
    } finally {
      setLoading(false);
    }
  };

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

      setEvidenceCid("");
      setEvidenceDescription("");
      await fetchEvidence();
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

  const getSubmitterRole = (address: string) => {
    if (address.toLowerCase() === clientAddress.toLowerCase()) return "Client";
    if (address.toLowerCase() === freelancerAddress.toLowerCase()) return "Freelancer";
    return "Arbiter";
  };

  const getSubmitterColor = (address: string) => {
    if (address.toLowerCase() === clientAddress.toLowerCase()) return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
    if (address.toLowerCase() === freelancerAddress.toLowerCase()) return "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200";
    return "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200";
  };

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts * 1000);
    return date.toLocaleString();
  };

  const parseCidAndDescription = (fullCid: string) => {
    const parts = fullCid.split("|");
    return {
      cid: parts[0],
      description: parts[1] || "",
    };
  };

  const isUserParty = wallet.address && (
    wallet.address.toLowerCase() === clientAddress.toLowerCase() ||
    wallet.address.toLowerCase() === freelancerAddress.toLowerCase()
  );

  return (
    <Card className="glass border-primary/20">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MessageSquare className="h-5 w-5" />
              Dispute Evidence & Communication
              <Badge variant="outline" className="ml-2">{evidence.length} Submissions</Badge>
            </CardTitle>
            <CardDescription>
              Evidence and communication thread for {encodeJobId(escrowId)}, Milestone {milestoneIndex}
            </CardDescription>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => void fetchEvidence()}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading...
              </>
            ) : (
              "Refresh"
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Single Evidence Thread - No Tabs */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <span className="ml-3">Loading evidence...</span>
          </div>
        ) : evidence.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground border rounded-lg">
            <FileText className="h-10 w-10 mx-auto mb-3 opacity-50" />
            <p>No evidence submitted yet</p>
            <p className="text-sm">Both parties can submit evidence to support their case</p>
          </div>
        ) : (
          <div className="space-y-3">
            {evidence.map((entry, idx) => {
              const { cid, description } = parseCidAndDescription(entry.cid);
              return (
                <motion.div
                  key={`${entry.blockNumber}-${idx}`}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                >
                  <Card className="border-l-4 border-l-primary/50">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <User className="h-4 w-4" />
                          <Badge className={getSubmitterColor(entry.submitter)}>
                            {getSubmitterRole(entry.submitter)}
                          </Badge>
                          <span className="text-xs font-mono text-muted-foreground">
                            {entry.submitter.slice(0, 6)}...{entry.submitter.slice(-4)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {formatTimestamp(entry.timestamp)}
                        </div>
                      </div>

                      {description && (
                        <p className="text-sm mb-2 text-foreground">{description}</p>
                      )}

                      <div className="flex items-center gap-2 bg-muted/50 p-2 rounded">
                        <FileText className="h-4 w-4 text-muted-foreground" />
                        <code className="text-xs flex-1 truncate">{cid}</code>
                        <Button
                          variant="ghost"
                          size="sm"
                          asChild
                        >
                          <a
                            href={cid.startsWith("http") ? cid : `https://ipfs.io/ipfs/${cid}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
