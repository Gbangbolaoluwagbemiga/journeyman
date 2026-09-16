import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash2, Sparkles } from "lucide-react";
import { AIMilestoneWriter } from "@/components/ai-milestone-writer";

interface Milestone {
  description: string;
  amount: string;
}

interface MilestonesStepProps {
  milestones: Milestone[];
  onUpdate: (milestones: Milestone[]) => void;
  showAIWriter: boolean;
  onToggleAIWriter: (show: boolean) => void;
  currentMilestoneIndex: number | null;
  onSetCurrentMilestoneIndex: (index: number | null) => void;
  totalBudget: string;
  projectTitle: string;
  projectDescription: string;
  durationDays: string;
  errors?: {
    milestones?: string;
    totalMismatch?: string;
  };
}

export function MilestonesStep({
  milestones,
  onUpdate,
  showAIWriter,
  onToggleAIWriter,
  currentMilestoneIndex,
  onSetCurrentMilestoneIndex,
  totalBudget,
  projectTitle,
  projectDescription,
  durationDays,
  errors = {},
}: MilestonesStepProps) {
  const addMilestone = () => {
    onUpdate([...milestones, { description: "", amount: "" }]);
  };

  const removeMilestone = (index: number) => {
    if (milestones.length > 1) {
      onUpdate(milestones.filter((_, i) => i !== index));
    }
  };

  const updateMilestone = (
    index: number,
    field: keyof Milestone,
    value: string
  ) => {
    const updated = [...milestones];
    updated[index] = { ...updated[index], [field]: value };
    onUpdate(updated);
  };

  const handleAIWriterResult = (result: Milestone[]) => {
    onUpdate(result);
    onToggleAIWriter(false);
    onSetCurrentMilestoneIndex(null);
  };

  return (
    <Card className="glass border-primary/20 p-6 sm:p-7">
      <CardHeader className="pb-4 space-y-0">
        <CardTitle className="text-xl">Milestones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {milestones.map((milestone, index) => (
          <div key={index} className="border border-border/40 rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h4 className="font-medium">Milestone {index + 1}</h4>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onSetCurrentMilestoneIndex(index);
                    onToggleAIWriter(true);
                  }}
                >
                  <Sparkles className="h-4 w-4 mr-1" />
                  AI Writer
                </Button>
                {milestones.length > 1 && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => removeMilestone(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {showAIWriter && currentMilestoneIndex === index && (
              <div className="mb-5">
                <AIMilestoneWriter
                  onResult={handleAIWriterResult}
                  onClose={() => {
                    onToggleAIWriter(false);
                    onSetCurrentMilestoneIndex(null);
                  }}
                  currentMilestoneIndex={currentMilestoneIndex}
                  existingMilestones={milestones}
                  projectTitle={projectTitle}
                  projectDescription={projectDescription}
                  totalBudget={totalBudget}
                  durationDays={durationDays}
                />
              </div>
            )}

            <div className="space-y-5">
              <div>
                <Label
                  htmlFor={`milestone-${index}-description`}
                  className="mb-2.5 block"
                >
                  Description *
                </Label>
                <Textarea
                  id={`milestone-${index}-description`}
                  value={milestone.description}
                  onChange={(e) =>
                    updateMilestone(index, "description", e.target.value)
                  }
                  placeholder="Describe what needs to be delivered..."
                  className={`min-h-[92px] leading-relaxed ${errors.milestones ? "border-red-500 focus:border-red-500" : ""}`}
                  required
                  minLength={10}
                />
                {errors.milestones ? (
                  <p className="text-red-500 text-sm mt-1">
                    {errors.milestones}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">
                    Minimum 10 characters required
                  </p>
                )}
              </div>

              <div>
                <Label
                  htmlFor={`milestone-${index}-amount`}
                  className="mb-2.5 block"
                >
                  Amount (USDC) *
                </Label>
                <Input
                  id={`milestone-${index}-amount`}
                  type="number"
                  value={milestone.amount}
                  onChange={(e) =>
                    updateMilestone(index, "amount", e.target.value)
                  }
                  placeholder="e.g., 500"
                  min="0.01"
                  step="0.01"
                  required
                  className={
                    errors.milestones
                      ? "border-red-500 focus:border-red-500"
                      : ""
                  }
                />
                {errors.milestones ? (
                  <p className="text-red-500 text-sm mt-1">
                    {errors.milestones}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground mt-1">
                    Minimum 0.0001 USDC required
                  </p>
                )}
              </div>
            </div>
          </div>
        ))}

        <Button
          type="button"
          variant="outline"
          onClick={addMilestone}
          className="w-full mt-4"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Milestone
        </Button>

        {/* Total Budget Checker */}
        <div className="mt-6 p-5 bg-muted/50 rounded-lg border">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">
                Total Milestone Amount:
              </Label>
              <div className="text-2xl font-bold text-primary">
                {milestones
                  .reduce(
                    (sum, m) => sum + (Number.parseFloat(m.amount) || 0),
                    0
                  )
                  .toFixed(2)}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium text-muted-foreground">
                Target Total:
              </Label>
              <div className="text-2xl font-bold text-foreground">
                {Number(totalBudget || 0).toFixed(2)}
              </div>
            </div>
          </div>

          {errors.totalMismatch && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-red-600 text-sm font-medium">
                Amount mismatch
              </p>
              <p className="text-red-500 text-sm">{errors.totalMismatch}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
