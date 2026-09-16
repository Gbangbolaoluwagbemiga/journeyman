import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWeb3 } from "@/contexts/web3-context";
import { useToast } from "@/hooks/use-toast";
import { contractService } from "@/lib/web3/contract-service";
import { Shield, ArrowLeft, Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { DisputeResolution } from "@/components/admin/dispute-resolution";
import { OverdueDisputeResolution } from "@/components/admin/overdue-dispute-resolution";

export default function DisputesPage() {
  const { wallet } = useWeb3();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [isOwner, setIsOwner] = useState(false);
  const [isCheckingOwner, setIsCheckingOwner] = useState(true);

  useEffect(() => {
    checkOwnership();
  }, [wallet.address]);

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
      
      const isAdmin = owner?.toLowerCase() === wallet.address.toLowerCase();
      setIsOwner(isAdmin);
      
      // Redirect if not admin
      if (!isAdmin) {
        toast({
          title: "Access Denied",
          description: "Only the contract owner can access this page",
          variant: "destructive",
        });
        navigate("/admin");
      }
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

  if (!wallet.isConnected) {
    return (
      <div className="min-h-screen py-12 gradient-mesh">
        <div className="container mx-auto px-4 max-w-6xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-6 w-6" />
                Dispute Management
              </CardTitle>
              <CardDescription>Manage and resolve disputes</CardDescription>
            </CardHeader>
            <CardContent>
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Wallet not connected</AlertTitle>
                <AlertDescription>
                  Please connect your wallet to access the dispute management page.
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
        <div className="container mx-auto px-4 max-w-6xl">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Shield className="h-6 w-6" />
                Dispute Management
              </CardTitle>
              <CardDescription>Manage and resolve disputes</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Access Denied</AlertTitle>
                <AlertDescription>
                  You are not the contract owner. Only the owner can access this page.
                </AlertDescription>
              </Alert>
              
              <Button onClick={() => navigate("/admin")} variant="outline" className="w-full">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Admin Panel
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen py-12 gradient-mesh">
      <div className="container mx-auto px-4 max-w-6xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold mb-2">Dispute Management</h1>
            <p className="text-muted-foreground">
              Review evidence, communicate with parties, and resolve disputes
            </p>
          </div>
          <Button onClick={() => navigate("/admin")} variant="outline">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Admin
          </Button>
        </div>

        {/* Dispute Resolution */}
        <DisputeResolution onDisputeResolved={() => {
          toast({
            title: "Dispute resolved",
            description: "The dispute has been resolved successfully",
          });
        }} />

        {/* Overdue Dispute Resolution */}
        <OverdueDisputeResolution onResolved={() => {
          toast({
            title: "Overdue dispute resolved",
            description: "The overdue dispute has been resolved successfully",
          });
        }} />
      </div>
    </div>
  );
}
