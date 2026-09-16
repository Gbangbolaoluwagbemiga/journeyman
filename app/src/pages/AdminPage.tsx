import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toastError } from "@/lib/atelier/errors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { contractService } from "@/lib/web3/contract-service";
import { useWriteContract } from "wagmi";
import { Shield, CheckCircle2, AlertCircle, Loader2, Coins, Lock, Percent, Trash2 } from "lucide-react";
import { decodeJobId, encodeJobId } from "@/lib/id-codec";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArbiterManagement } from "@/components/admin/arbiter-management";

const USDC_ADDRESS = (
  (import.meta.env.VITE_USDC_TOKEN_CONTRACT as string | undefined) ?? ""
).trim();

export default function AdminPage() {
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const { writeContractAsync } = useWriteContract();
  const navigate = useNavigate();
  const [isOwner, setIsOwner] = useState(false);
  const [isCheckingOwner, setIsCheckingOwner] = useState(true);
  const [tokenAddress, setTokenAddress] = useState(USDC_ADDRESS);
  const [isWhitelisting, setIsWhitelisting] = useState(false);
  const [isDelisting, setIsDelisting] = useState(false);
  const [delistAddress, setDelistAddress] = useState("");
  /* Read from the contract rather than assumed — see the display card. */
  const [usdcWhitelisted, setUsdcWhitelisted] = useState(false);

  // Platform fee state
  const [currentFeeBP, setCurrentFeeBP] = useState<number | null>(null);
  const [newFeePercent, setNewFeePercent] = useState("");
  const [isSettingFee, setIsSettingFee] = useState(false);

  // Collected fees state
  const [collectedFees, setCollectedFees] = useState<bigint | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [isWithdrawingFees, setIsWithdrawingFees] = useState(false);

  // Delete escrow state
  const [deleteInput, setDeleteInput] = useState(""); // accepts SF-XXXXX or raw number
  const [isDeletingEscrow, setIsDeletingEscrow] = useState(false);

  useEffect(() => {
    checkOwnership();
  }, [wallet.address]);

  useEffect(() => {
    if (!isOwner) return;
    contractService.getPlatformFeeBP().then(setCurrentFeeBP);
    if (USDC_ADDRESS) contractService.getCollectedFees(USDC_ADDRESS).then(setCollectedFees);
  }, [isOwner]);

  const isUserRejection = (error: any) => {
    const msg: string = error?.message || error?.details || "";
    return (
      error?.code === 4001 ||
      msg.includes("User rejected") ||
      msg.includes("user rejected") ||
      msg.includes("rejected the request") ||
      msg.includes("denied transaction")
    );
  };

  const handleWithdrawFees = async () => {
    if (!USDC_ADDRESS) return;
    const available = Number(collectedFees ?? 0n) / 1e6;
    const amount = parseFloat(withdrawAmount);
    if (isNaN(amount) || amount <= 0 || amount > available) {
      toast({ title: "Invalid amount", description: `Enter an amount between 0.01 and ${available.toFixed(2)} USDC.`, variant: "destructive" });
      return;
    }
    setIsWithdrawingFees(true);
    try {
      await contractService.withdrawFees(USDC_ADDRESS, (args) => writeContractAsync(args));
      toast({ title: "Fees withdrawn", description: `${amount.toFixed(2)} USDC sent to fee collector wallet.` });
      const updated = await contractService.getCollectedFees(USDC_ADDRESS);
      setCollectedFees(updated);
      setWithdrawAmount("");
    } catch (error: any) {
      if (isUserRejection(error)) {
        toast({ title: "Cancelled", description: "You rejected the transaction in your wallet.", variant: "destructive" });
      } else {
        toast({ title: "Withdrawal failed", description: "Transaction failed. Please try again.", variant: "destructive" });
      }
    } finally {
      setIsWithdrawingFees(false);
    }
  };

  const handleSetPlatformFee = async () => {
    const pct = parseFloat(newFeePercent);
    if (isNaN(pct) || pct < 0 || pct > 15) {
      toast({ title: "Invalid fee", description: "Enter a percentage between 0 and 15.", variant: "destructive" });
      return;
    }
    const bp = Math.round(pct * 100);
    setIsSettingFee(true);
    try {
      await contractService.setPlatformFee(bp, (args) => writeContractAsync(args));
      setCurrentFeeBP(bp);
      setNewFeePercent("");
      toast({ title: "Platform fee updated", description: `Fee set to ${pct}% (${bp} basis points).` });
    } catch (error: any) {
      if (isUserRejection(error)) {
        toast({ title: "Cancelled", description: "You rejected the transaction in your wallet.", variant: "destructive" });
      } else {
        toast({ title: "Failed to update fee", description: "Transaction failed. Please try again.", variant: "destructive" });
      }
    } finally {
      setIsSettingFee(false);
    }
  };

  const handleDeleteEscrow = async () => {
    const raw = deleteInput.trim();
    if (!raw) return;

    // Accept both encoded "SF-XXXXX" and raw numeric IDs
    const onChainId = raw.startsWith("SF-") ? decodeJobId(raw) : parseInt(raw, 10);
    if (!Number.isFinite(onChainId) || onChainId <= 0) {
      toast({ title: "Invalid ID", description: "Enter a valid escrow ID (e.g. SF-LK4Q1 or 7).", variant: "destructive" });
      return;
    }

    setIsDeletingEscrow(true);
    try {
      await contractService.deleteEscrow(onChainId, (args) => writeContractAsync(args));
      toast({
        title: "Escrow deleted",
        description: `${encodeJobId(onChainId)} (on-chain #${onChainId}) has been permanently removed.`,
      });
      setDeleteInput("");
    } catch (error: any) {
      if (isUserRejection(error)) {
        toast({ title: "Cancelled", description: "You rejected the transaction in your wallet.", variant: "destructive" });
      } else {
        const msg: string = error?.message || "";
        const friendly = msg.includes("InvalidEscrowStatus")
          ? "Escrow must be in a terminal state (released, refunded, expired, or cancelled) before deletion."
          : msg.includes("InvalidAmount")
          ? "Escrow still has funds. Ensure all funds are withdrawn or paid out first."
          : msg.includes("EscrowNotFound")
          ? "No escrow found with that ID."
          : "Transaction failed. Please try again.";
        toast({ title: "Delete failed", description: friendly, variant: "destructive" });
      }
    } finally {
      setIsDeletingEscrow(false);
    }
  };

  const checkOwnership = async () => {
    if (!wallet.address) {
      setIsOwner(false);
      setIsCheckingOwner(false);
      return;
    }

    setIsCheckingOwner(true);
    try {
      const owner = await contractService.getOwner();
      
      if (!owner) {
        toast({
          title: "Connection Issue",
          description: "Failed to verify admin access. Retrying...",
          variant: "destructive",
        });
        
        // Retry after 2 seconds
        setTimeout(() => {
          checkOwnership();
        }, 2000);
        return;
      }
      
      setIsOwner(owner?.toLowerCase() === wallet.address.toLowerCase());
    } catch (error) {
      toast({
        title: "Connection Error",
        description: "Failed to connect to blockchain. Please refresh the page.",
        variant: "destructive",
      });
      setIsOwner(false);
    } finally {
      setIsCheckingOwner(false);
    }
  };

  const refreshTokenStatus = useCallback(async () => {
    setUsdcWhitelisted(await contractService.isTokenWhitelisted(USDC_ADDRESS));
  }, []);

  useEffect(() => {
    void refreshTokenStatus();
  }, [refreshTokenStatus]);

  const handleWhitelistToken = async () => {
    if (!tokenAddress || !/^0x[a-fA-F0-9]{40}$/.test(tokenAddress)) {
      toast({
        title: "Invalid Address",
        description: "Please enter a valid EVM address (0x...)",
        variant: "destructive",
      });
      return;
    }

    setIsWhitelisting(true);
    try {
      const hash = await contractService.whitelistToken(
        tokenAddress,
        (args) => writeContractAsync(args)
      );

      toast({
        title: "Token Whitelisted Successfully",
        description: `Token has been added to the whitelist. Transaction: ${hash.slice(0, 10)}...`,
      });

      setTokenAddress("");
    } catch (error: any) {
      toast({
        title: "Failed to Whitelist Token",
        description: error?.message || "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsWhitelisting(false);
    }
  };

  /**
   * Stop accepting a token for NEW escrows.
   *
   * Deliberately worded as "stop accepting" rather than "remove": escrows
   * already funded in this token keep releasing and refunding normally. An
   * owner delisting something needs to know they are not stranding money that
   * is already in flight.
   */
  const handleDelistToken = async (token: string) => {
    setIsDelisting(true);
    try {
      const hash = await contractService.delistToken(token, (args) =>
        writeContractAsync(args)
      );
      toast({
        title: "Token delisted",
        description: `No new escrows can be funded in it. Existing ones are unaffected. Transaction: ${hash.slice(0, 10)}…`,
      });
      void refreshTokenStatus();
    } catch (error) {
      toast(toastError("Could not delist that token", error));
    } finally {
      setIsDelisting(false);
    }
  };

  const handleQuickWhitelistUSDC = async () => {
    if (!USDC_ADDRESS) {
      toast({
        title: "USDC Not Configured",
        description: "Set VITE_USDC_TOKEN_CONTRACT in your .env file",
        variant: "destructive",
      });
      return;
    }

    setIsWhitelisting(true);
    try {
      const hash = await contractService.whitelistToken(
        USDC_ADDRESS,
        (args) => writeContractAsync(args)
      );

      toast({
        title: "USDC Whitelisted Successfully",
        description: `Users can now create escrows with USDC. Transaction: ${hash.slice(0, 10)}...`,
      });
    } catch (error: any) {
      const message = error?.message || "Something went wrong";
      
      // Check if already whitelisted
      if (message.includes("already whitelisted") || message.includes("AlreadyWhitelisted")) {
        toast({
          title: "USDC Already Whitelisted",
          description: "This token is already available for escrows",
        });
      } else {
        toast({
          title: "Failed to Whitelist USDC",
          description: message,
          variant: "destructive",
        });
      }
    } finally {
      setIsWhitelisting(false);
    }
  };

  if (!wallet.isConnected) {
    return (
      <div className="min-h-screen py-12 gradient-mesh">
        <div className="container mx-auto px-4 max-w-4xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-6 w-6" />
                Admin Panel
              </CardTitle>
              <CardDescription>Manage Atelier contract settings</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Wallet not connected</AlertTitle>
                <AlertDescription>
                  Please connect your wallet to access the admin panel.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (isCheckingOwner) {
    return (
      <div className="min-h-screen py-12 gradient-mesh flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="min-h-screen py-12 gradient-mesh">
        <div className="container mx-auto px-4 max-w-4xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-6 w-6" />
                Admin Panel
              </CardTitle>
              <CardDescription>Manage Atelier contract settings</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Access Denied</AlertTitle>
                <AlertDescription>
                  You are not the contract owner. Only the owner can access this panel.
                </AlertDescription>
              </Alert>
              
              <div className="bg-muted/50 p-4 rounded-lg space-y-2">
                <p className="text-sm font-medium">Troubleshooting:</p>
                <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                  <li>Make sure you're connected with the owner wallet</li>
                  <li>Check if the RPC connection is working</li>
                  <li>Try refreshing the page</li>
                </ul>
                <Button 
                  onClick={() => {
                    setIsCheckingOwner(true);
                    checkOwnership();
                  }} 
                  variant="outline" 
                  className="w-full mt-3"
                  disabled={isCheckingOwner}
                >
                  {isCheckingOwner ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Checking...
                    </>
                  ) : (
                    "Retry Access Check"
                  )}
                </Button>
              </div>
              
              <div className="text-xs text-muted-foreground space-y-1">
                <p><strong>Your Address:</strong> <code className="bg-muted px-1 py-0.5 rounded">{wallet.address}</code></p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 gradient-mesh">
      <div className="container mx-auto px-4 max-w-6xl space-y-6">
        <div>
          <h1 className="text-4xl font-bold mb-2">Admin Panel</h1>
          <p className="text-muted-foreground">
            Manage Atelier contract settings and configurations
          </p>
        </div>

        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Owner Access Confirmed</AlertTitle>
          <AlertDescription>
            You are connected as the contract owner and can manage settings.
          </AlertDescription>
        </Alert>

        {/* Grid Layout for Admin Controls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* Token Management Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Add Custom Token
              </CardTitle>
              <CardDescription>Whitelist ERC-20 tokens</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="tokenAddress">Token Contract Address</Label>
                <Input
                  id="tokenAddress"
                  placeholder="0x..."
                  value={tokenAddress}
                  onChange={(e) => setTokenAddress(e.target.value)}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Enter the ERC-20 token contract address
                </p>
              </div>

              <Button
                onClick={handleWhitelistToken}
                disabled={isWhitelisting || !tokenAddress}
                className="w-full"
              >
                {isWhitelisting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Whitelisting...
                  </>
                ) : (
                  "Whitelist Token"
                )}
              </Button>
            </CardContent>
          </Card>

          {/* Whitelisted Tokens Display Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                Whitelisted Tokens
              </CardTitle>
              <CardDescription>Active tokens in the system</CardDescription>
            </CardHeader>
            <CardContent>
              {/* This card used to say "1 Token Whitelisted" unconditionally,
                  which is a claim about chain state made without reading chain
                  state — it would have kept saying it after a delist. */}
              <div className="space-y-3">
                <div
                  className={`rounded-lg p-3 border ${
                    usdcWhitelisted
                      ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                      : "bg-muted/40 border-border"
                  }`}
                >
                  <p className="text-sm font-semibold">
                    {usdcWhitelisted
                      ? "USDC is accepted for new escrows"
                      : "USDC is not currently accepted"}
                  </p>
                  {!usdcWhitelisted && (
                    <p className="text-xs text-muted-foreground mt-1">
                      No new job can be funded until a token is whitelisted.
                    </p>
                  )}
                </div>

                <div className="text-xs font-mono bg-muted p-2 rounded break-all">
                  <span className="text-muted-foreground">USDC: </span>
                  {USDC_ADDRESS}
                </div>

                {usdcWhitelisted && (
                  <Button
                    variant="outline"
                    className="w-full border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={isDelisting}
                    onClick={() => void handleDelistToken(USDC_ADDRESS)}
                  >
                    {isDelisting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Delisting…
                      </>
                    ) : (
                      "Stop accepting USDC"
                    )}
                  </Button>
                )}

                <div className="pt-1 space-y-2">
                  <Label htmlFor="delistAddress" className="text-xs">
                    Delist another token
                  </Label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      id="delistAddress"
                      placeholder="0x…"
                      value={delistAddress}
                      onChange={(e) => setDelistAddress(e.target.value)}
                      className="font-mono text-sm"
                    />
                    <Button
                      variant="outline"
                      className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10"
                      disabled={isDelisting || !/^0x[a-fA-F0-9]{40}$/.test(delistAddress)}
                      onClick={() => {
                        void handleDelistToken(delistAddress);
                        setDelistAddress("");
                      }}
                    >
                      Delist
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Existing escrows in a delisted token still release and refund
                    normally — this only stops new ones.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Delete Escrow */}
        <Card className="border-red-200 dark:border-red-900/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <Trash2 className="h-5 w-5" />
              Delete Escrow
            </CardTitle>
            <CardDescription>
              Permanently removes an escrow record from on-chain storage.
              The escrow must be in a terminal state (released, refunded, expired,
              or cancelled) with zero remaining funds.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="deleteId">Escrow ID</Label>
              <div className="flex gap-2">
                <Input
                  id="deleteId"
                  placeholder="SF-LK4Q1 or raw number"
                  value={deleteInput}
                  onChange={(e) => setDeleteInput(e.target.value)}
                  className="font-mono"
                />
                <Button
                  variant="destructive"
                  onClick={handleDeleteEscrow}
                  disabled={isDeletingEscrow || !deleteInput.trim()}
                  className="shrink-0"
                >
                  {isDeletingEscrow ? <Loader2 className="h-4 w-4 animate-spin" /> : "Delete"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Accepts the encoded ID (e.g. <code>SF-LK4Q1</code>) or the raw
                on-chain number. This action is irreversible.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Platform Fee + Collected Fees — side by side */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Platform Fee */}
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Percent className="h-5 w-5" />
                Platform Fee
              </CardTitle>
              <CardDescription>
                Current:{" "}
                {currentFeeBP === null ? (
                  <Loader2 className="inline h-3 w-3 animate-spin" />
                ) : (
                  <strong>{(currentFeeBP / 100).toFixed(2)}% ({currentFeeBP} bp)</strong>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newFee">New Fee (%)</Label>
                <div className="flex gap-2">
                  <Input
                    id="newFee"
                    type="number"
                    min="0"
                    max="15"
                    step="0.01"
                    placeholder="e.g. 2.5"
                    value={newFeePercent}
                    onChange={(e) => setNewFeePercent(e.target.value)}
                  />
                  <Button
                    onClick={() => void handleSetPlatformFee()}
                    disabled={isSettingFee || !newFeePercent}
                    className="shrink-0"
                  >
                    {isSettingFee ? <Loader2 className="h-4 w-4 animate-spin" /> : "Set Fee"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter 0–15%. Stored as basis points (1% = 100 bp).
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Collected Fees */}
          <Card className="flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Collected Fees
              </CardTitle>
              <CardDescription>
                Available:{" "}
                {collectedFees === null ? (
                  <Loader2 className="inline h-3 w-3 animate-spin" />
                ) : (
                  <strong>{(Number(collectedFees) / 1e6).toFixed(2)} USDC</strong>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="withdrawAmt">Amount to Withdraw (USDC)</Label>
                <div className="flex gap-2">
                  <Input
                    id="withdrawAmt"
                    type="number"
                    min="0.01"
                    max={collectedFees ? (Number(collectedFees) / 1e6).toFixed(6) : undefined}
                    step="0.01"
                    placeholder="e.g. 5.00"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(e.target.value)}
                    disabled={!collectedFees || collectedFees === 0n}
                  />
                  <Button
                    onClick={() => void handleWithdrawFees()}
                    disabled={isWithdrawingFees || !withdrawAmount || !collectedFees || collectedFees === 0n}
                    className="shrink-0"
                  >
                    {isWithdrawingFees ? <Loader2 className="h-4 w-4 animate-spin" /> : "Withdraw"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Sent to the fee collector wallet set at deployment.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Arbiter Management */}
        <ArbiterManagement onArbiterAdded={() => {
          toast({
            title: "Arbiter Authorized",
            description: "The arbiter has been successfully authorized",
          });
        }} onArbiterRemoved={() => {
          toast({
            title: "Arbiter Removed",
            description: "The arbiter has been successfully removed",
          });
        }} />

        {/* Dispute Management - Navigate to Separate Page */}
        <Card className="border-orange-200 bg-orange-50/50 dark:bg-orange-900/10">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-orange-600" />
              Dispute Management
            </CardTitle>
            <CardDescription>
              View and resolve disputes on a dedicated page for better performance
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button 
              onClick={() => navigate('/disputes')} 
              className="w-full bg-orange-600 hover:bg-orange-700"
              size="lg"
            >
              Open Dispute Management Page
            </Button>
            <p className="text-xs text-muted-foreground mt-3 text-center">
              Manage active disputes, review evidence, and communicate with parties
            </p>
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
