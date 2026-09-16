import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const WALLET_ADDRESS = "0xc11e0000000000000000000000000000000001";
const OTHER_PARTY = "0xfee1000000000000000000000000000000fee1";

vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
}));

vi.mock("@/contexts/web3-context", () => ({
  useWeb3: () => ({ wallet: { address: WALLET_ADDRESS, isConnected: true, balance: "0" } }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const addCrossWalletNotificationMock = vi.fn();
vi.mock("@/contexts/notification-context", () => ({
  useNotifications: () => ({ addCrossWalletNotification: addCrossWalletNotificationMock }),
}));

const submitEvidenceMock = vi.fn().mockResolvedValue("0xtxhash");
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: vi.fn().mockImplementation(function MockContractService(this: any) {
    this.submitEvidence = submitEvidenceMock;
  }),
}));

const { EvidenceSubmissionButton } = await import("@/components/evidence-submission-button");

beforeEach(() => {
  addCrossWalletNotificationMock.mockClear();
  submitEvidenceMock.mockClear();
});

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /submit evidence/i }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/evidence link or ipfs cid/i), "QmTestCid123");
  fireEvent.click(within(dialog).getByRole("button", { name: /submit evidence/i }));
}

describe("EvidenceSubmissionButton — notifies the other party (fixed bug: no notification on evidence submission)", () => {
  it("notifies otherPartyAddress when evidence is submitted", async () => {
    const user = userEvent.setup();
    render(
      <EvidenceSubmissionButton
        escrowId="1"
        milestoneIndex={2}
        otherPartyAddress={OTHER_PARTY}
        projectTitle="Landing Page Redesign"
      />,
    );

    await fillAndSubmit(user);

    await waitFor(() => expect(submitEvidenceMock).toHaveBeenCalledTimes(1));
    expect(addCrossWalletNotificationMock).toHaveBeenCalledTimes(1);
    const [payload, clientAddress, freelancerAddress] = addCrossWalletNotificationMock.mock.calls[0];
    expect(payload.type).toBe("dispute");
    expect(payload.message).toContain("milestone 3"); // milestoneIndex 2 -> human "milestone 3"
    expect(payload.message).toContain("Landing Page Redesign");
    expect(clientAddress).toBeUndefined();
    expect(freelancerAddress).toBe(OTHER_PARTY);
  });

  it("does not notify (and does not crash) when no otherPartyAddress is provided", async () => {
    const user = userEvent.setup();
    render(<EvidenceSubmissionButton escrowId="1" milestoneIndex={0} />);

    await fillAndSubmit(user);

    await waitFor(() => expect(submitEvidenceMock).toHaveBeenCalledTimes(1));
    expect(addCrossWalletNotificationMock).not.toHaveBeenCalled();
  });
});
