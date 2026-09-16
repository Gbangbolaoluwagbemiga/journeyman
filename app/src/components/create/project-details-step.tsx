import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CATEGORIES, type CategoryId } from "@/lib/atelier/categories";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { isApiConfigured, postRewriteText } from "@/lib/api";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type WhitelistedToken = { symbol: string; address: string };

const USDC_TOKEN_CONTRACT =
  (import.meta.env.VITE_USDC_TOKEN_CONTRACT as string | undefined)?.trim() ??
  "";

export const WHITELISTED_TOKENS: WhitelistedToken[] = [
  { symbol: "USDC", address: USDC_TOKEN_CONTRACT },
].filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address));

interface ProjectDetailsStepProps {
  formData: {
    projectTitle: string;
    projectDescription: string;
    category?: CategoryId;
    duration: string;
    totalBudget: string;
    beneficiary: string;
    token: string;
    useNativeToken: boolean;
    isOpenJob: boolean;
  };
  onUpdate: (data: Partial<ProjectDetailsStepProps["formData"]>) => void;
  isContractPaused: boolean;
  errors?: {
    projectTitle?: string;
    projectDescription?: string;
    duration?: string;
    totalBudget?: string;
    beneficiary?: string;
    tokenAddress?: string;
  };
}

export function ProjectDetailsStep({
  formData,
  onUpdate,
  isContractPaused,
  errors = {} as ProjectDetailsStepProps["errors"],
}: ProjectDetailsStepProps) {
  const { toast } = useToast();
  const [rewriting, setRewriting] = useState(false);

  const rewriteDescription = async () => {
    const text = formData.projectDescription?.trim() ?? "";
    if (!text) return;
    if (!isApiConfigured()) {
      toast({
        title: "API not configured",
        description: "Run the backend (npm run dev) for AI rewrite in local dev.",
        variant: "destructive",
      });
      return;
    }
    setRewriting(true);
    try {
      const { text: rewritten } = await postRewriteText({ text });
      onUpdate({ projectDescription: rewritten });
      toast({
        title: "Improved",
        description: "Grammar and clarity updated — review before submitting.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Rewrite failed";
      toast({
        title: "AI unavailable",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setRewriting(false);
    }
  };

  return (
    <Card className="glass border-primary/20 p-6">
      <CardHeader>
        <CardTitle>Project Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        {isContractPaused && (
          <Alert variant="destructive" className="mb-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Contract is currently paused. Escrow creation is temporarily
              disabled.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <Label htmlFor="projectTitle" className="mb-2 block">
              Project Title *
            </Label>
            <Input
              id="projectTitle"
              value={formData.projectTitle}
              onChange={(e) => onUpdate({ projectTitle: e.target.value })}
              placeholder="Enter project title"
              required
              minLength={3}
              className={
                errors?.projectTitle
                  ? "border-red-500 focus:border-red-500"
                  : ""
              }
            />
            {errors?.projectTitle && (
              <p className="text-red-500 text-sm mt-1">{errors.projectTitle}</p>
            )}
          </div>

          <div>
            <Label htmlFor="category" className="mb-2 block">
              Kind of work *
            </Label>
            <select
              id="category"
              value={formData.category ?? "design"}
              onChange={(e) => onUpdate({ category: e.target.value as CategoryId })}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} — {c.hint}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground mt-1">
              What freelancers filter the board by.
            </p>
          </div>

          <div>
            <Label htmlFor="duration" className="mb-2 block">
              Duration (days) *
            </Label>
            <Input
              id="duration"
              type="number"
              value={formData.duration}
              onChange={(e) => onUpdate({ duration: e.target.value })}
              placeholder="e.g., 30"
              min="1"
              max="365"
              required
              className={
                errors?.duration ? "border-red-500 focus:border-red-500" : ""
              }
            />
            {errors?.duration && (
              <p className="text-red-500 text-sm mt-1">{errors.duration}</p>
            )}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-2">
            <Label htmlFor="projectDescription" className="block">
              Project Description *
            </Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void rewriteDescription()}
              disabled={
                rewriting ||
                !formData.projectDescription?.trim() ||
                !!errors?.projectDescription
              }
            >
              <Sparkles className="h-3.5 w-3.5" />
              {rewriting ? "Improving…" : "Improve with AI"}
            </Button>
          </div>
          <Textarea
            id="projectDescription"
            value={formData.projectDescription}
            onChange={(e) => onUpdate({ projectDescription: e.target.value })}
            placeholder="Describe the project requirements and deliverables..."
            className={`min-h-[120px] ${
              errors?.projectDescription
                ? "border-red-500 focus:border-red-500"
                : ""
            }`}
            required
            minLength={50}
          />
          {errors?.projectDescription ? (
            <p className="text-red-500 text-sm mt-1">
              {errors.projectDescription}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              Minimum 50 characters required
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <Label htmlFor="totalBudget" className="mb-2 block">
              Total Budget (USDC) *
            </Label>
            <Input
              id="totalBudget"
              type="number"
              value={formData.totalBudget}
              onChange={(e) => onUpdate({ totalBudget: e.target.value })}
              placeholder="e.g., 1000"
              min="0.01"
              step="0.01"
              required
              className={
                errors?.totalBudget ? "border-red-500 focus:border-red-500" : ""
              }
            />
            {errors?.totalBudget ? (
              <p className="text-red-500 text-sm mt-1">{errors.totalBudget}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                Minimum 0.0001 USDC required
              </p>
            )}
          </div>

          <div>
            <Label className="mb-2 block">Job Type *</Label>
            <div className="flex items-center gap-3 rounded-md border border-input px-3 py-2.5">
              <input
                type="checkbox"
                id="isOpenJob"
                checked={formData.isOpenJob}
                onChange={(e) => onUpdate({ isOpenJob: e.target.checked })}
                className="rounded w-4 h-4 shrink-0"
              />
              <Label htmlFor="isOpenJob" className="cursor-pointer">
                Open Job (Allow Applications)
              </Label>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {formData.isOpenJob
                ? "Listed publicly on Browse Jobs — any freelancer can apply."
                : "Not listed publicly. You'll assign it directly to one freelancer's wallet below — for a private job or assessment."}
            </p>
          </div>
        </div>

        {!formData.isOpenJob && (
          <div>
            <Label htmlFor="beneficiary" className="mb-2 block">
              Freelancer Wallet Address *
            </Label>
            <Input
              id="beneficiary"
              value={formData.beneficiary}
              onChange={(e) => onUpdate({ beneficiary: e.target.value })}
              placeholder="0x..."
              required
              pattern="^0x[a-fA-F0-9]{40}$"
              className={
                errors?.beneficiary ? "border-red-500 focus:border-red-500" : ""
              }
            />
            {errors?.beneficiary ? (
              <p className="text-red-500 text-sm mt-1">{errors.beneficiary}</p>
            ) : (
              <p className="text-xs text-muted-foreground mt-1">
                Sends this job directly to one freelancer instead of listing it
                publicly. Valid Arc EVM address (0x…) required.
              </p>
            )}
          </div>
        )}

        <div className="space-y-8 mt-4">
          <div className="flex items-center space-x-3">
            <input
              type="checkbox"
              id="useNativeToken"
              checked={formData.useNativeToken}
              onChange={(e) => onUpdate({ useNativeToken: e.target.checked })}
              className="rounded w-4 h-4"
            />
            <Label htmlFor="useNativeToken" className="cursor-pointer ml-1">
              Use Arc Testnet USDC (Recommended)
            </Label>
          </div>

          {!formData.useNativeToken && (
            <div className="space-y-2">
              <div className="flex items-center gap-4">
                <Label htmlFor="tokenAddress" className="shrink-0">
                  Whitelisted Token *
                </Label>
                <div className="flex-1">
                  <Select
                    value={formData.token}
                    onValueChange={(val) => onUpdate({ token: val })}
                    disabled={WHITELISTED_TOKENS.length === 0}
                  >
                    <SelectTrigger
                      id="tokenAddress"
                      className={`w-full ${errors?.tokenAddress ? "border-red-500 focus:ring-red-500" : ""}`}
                    >
                      <SelectValue placeholder="Select a token" />
                    </SelectTrigger>
                    <SelectContent>
                      {WHITELISTED_TOKENS.map((t) => (
                        <SelectItem key={t.symbol} value={t.address}>
                          {t.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {errors?.tokenAddress && (
                <p className="text-red-500 text-sm">{errors.tokenAddress}</p>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
