/**
 * Wires the assistant to who is actually looking at it.
 *
 * Kept apart from the panel so the panel stays a presentation component that
 * takes a viewer and renders a conversation — easy to test, and impossible for
 * it to reach for a wallet hook it should not care about.
 *
 * What gets passed is coarse by design: a role and two counts. Enough for the
 * assistant to answer "why can't I send the next stage" about the right side of
 * the table, and never enough to leak a balance, an address or a counterparty
 * into a language model.
 */

import { AskAtelier } from "@/components/atelier/ask-atelier";
import { useFreelancerStatus } from "@/hooks/use-freelancer-status";
import { useJobCreatorStatus } from "@/hooks/use-job-creator-status";

export function AskAtelierDock() {
  const { isFreelancer } = useFreelancerStatus();
  const { isJobCreator } = useJobCreatorStatus();

  const role =
    isFreelancer && isJobCreator
      ? "both"
      : isFreelancer
        ? "freelancer"
        : isJobCreator
          ? "client"
          : null;

  return <AskAtelier viewer={{ role }} />;
}
