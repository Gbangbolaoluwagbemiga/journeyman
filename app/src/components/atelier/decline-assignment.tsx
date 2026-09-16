import { useState } from "react";
import { useWriteContract } from "wagmi";
import { XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWeb3 } from "@/contexts/web3-context";
import { ContractService } from "@/lib/web3/contract-service";
import { CONTRACTS } from "@/lib/web3/config";
import { sendMessage, isApiConfigured } from "@/lib/api";

/**
 * SAYING NO TO A JOB SOMEBODY PUT YOUR NAME ON.
 *
 * A directly assigned escrow names a freelancer who never agreed to it. Before
 * this their only exits were to ignore it — which leaves the client waiting on
 * someone who is never coming, and their budget locked — or to start work they
 * did not want. Neither is consent.
 *
 * WHY THE REASON IS A MESSAGE AND NOT A TRANSACTION
 *
 * The contract takes no string: the runtime is 148 bytes from EIP-170, and
 * more to the point a client cannot reply to an event. "Booked until March" and
 * "the budget is under my rate" are the start of a negotiation, not a receipt —
 * so the reason goes to the message thread, where the client can meet it and
 * offer the job again. That is the first of the three answers they get.
 *
 * The reason is optional. Someone who just wants out should not have to explain
 * themselves to leave, and requiring it would only produce empty strings.
 */
export function DeclineAssignment({
  escrowId,
  clientAddress,
  jobTitle,
  onDone,
}: {
  escrowId: number;
  clientAddress?: string;
  jobTitle?: string;
  onDone?: () => void;
}) {
  const { wallet } = useWeb3();
  const { writeContractAsync } = useWriteContract();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function decline() {
    setBusy(true);
    try {
      await new ContractService(CONTRACTS.ATELIER_ESCROW).declineAssignment(
        escrowId,
        writeContractAsync,
      );

      /*
       * The message is sent after the decline, and its failure is not the
       * decline's failure. The transaction is what frees both sides; the note
       * is a courtesy on top, and an unreachable message store must not make a
       * freelancer think they are still on the hook.
       */
      if (reason.trim() && clientAddress && wallet.address && isApiConfigured()) {
        try {
          await sendMessage({
            sender_address: wallet.address,
            recipient_address: clientAddress,
            content: `I've declined "${jobTitle ?? `job #${escrowId}`}".\n\n${reason.trim()}`,
          });
        } catch {
          toast({
            title: "Declined, but your note didn't send",
            description: "The job is back with the client. Send them a message if you'd like to explain.",
          });
        }
      }

      toast({
        title: "Job declined",
        description: "You're off this job. The client decides what happens to it next.",
      });
      setOpen(false);
      setReason("");
      onDone?.();
    } catch (err: unknown) {
      toast({
        title: "Could not decline",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        className="gap-2"
        data-testid="decline-button"
      >
        <XCircle className="h-4 w-4" aria-hidden="true" />
        Decline
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="decline-dialog">
          <DialogHeader>
            <DialogTitle>Decline this job?</DialogTitle>
            <DialogDescription>
              You'll be taken off it and the client will decide what happens
              next — they may fix whatever the problem is and offer it to you
              again, open it to everyone, or take their money back. Nothing is
              paid or lost either way.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <label htmlFor="decline-reason" className="text-sm font-medium">
              Why? <span className="text-muted-foreground font-normal">Optional</span>
            </label>
            <Textarea
              id="decline-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="The budget is under my rate · I'm booked until March · This isn't the kind of work I do"
              rows={3}
              data-testid="decline-reason"
            />
            <p className="text-xs text-muted-foreground">
              Sent to the client as a message, so they can reply and offer it
              again on different terms.
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Keep the job
            </Button>
            <Button onClick={decline} disabled={busy} className="gap-2" data-testid="decline-confirm">
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Decline
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
