import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const WALLET_ADDRESS = "0xc11e0000000000000000000000000000000001";

vi.mock("wagmi", () => ({
  useWriteContract: () => ({ writeContractAsync: vi.fn() }),
  usePublicClient: () => ({ waitForTransactionReceipt: vi.fn().mockResolvedValue({}) }),
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

const getApplicationDetailsMock = vi.fn();
const cancelJobMock = vi.fn().mockResolvedValue("0xtxhash");
vi.mock("@/lib/web3/contract-service", () => ({
  ContractService: vi.fn().mockImplementation(function MockContractService(this: any) {
    this.getApplicationDetails = getApplicationDetailsMock;
    this.cancelJob = cancelJobMock;
  }),
}));

const { JobManagement } = await import("@/components/job-management");

const APPLICANT_A = "0xaaaa000000000000000000000000000000aaaa";
const APPLICANT_B = "0xbbbb000000000000000000000000000000bbbb";

beforeEach(() => {
  addCrossWalletNotificationMock.mockClear();
  cancelJobMock.mockClear();
  getApplicationDetailsMock.mockReset();
  getApplicationDetailsMock.mockResolvedValue([
    { freelancer: APPLICANT_A, coverLetter: "", proposedTimeline: 0 },
    { freelancer: APPLICANT_B, coverLetter: "", proposedTimeline: 0 },
  ]);
});

describe("JobManagement — cancel-job notifies every applicant (fixed bug: previously silent)", () => {
  it("notifies every applicant that the job was cancelled, before it existed there was no notification at all", async () => {
    const user = userEvent.setup();
    render(
      <JobManagement
        escrowId="1"
        isOpenJob={true}
        isClient={true}
        totalAmount="10000000"
        token="0xUSDC"
        projectTitle="Landing Page Redesign"
        milestones={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel Job" }));
    await screen.findByText("Cancel This Job?");
    // Radix hides the trigger from the accessibility tree while the dialog
    // is open, so only the confirm action matches here.
    const confirmButton = screen.getByRole("button", { name: "Cancel Job" });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(cancelJobMock).toHaveBeenCalledTimes(1));
    expect(cancelJobMock).toHaveBeenCalledWith(
      { escrow_id: 1, depositor: WALLET_ADDRESS },
      expect.anything(),
    );

    await waitFor(() => expect(addCrossWalletNotificationMock).toHaveBeenCalledTimes(2));
    const notifiedAddresses = addCrossWalletNotificationMock.mock.calls.map((call) => call[2]);
    expect(notifiedAddresses).toEqual(expect.arrayContaining([APPLICANT_A, APPLICANT_B]));

    const [notificationPayload] = addCrossWalletNotificationMock.mock.calls[0];
    expect(notificationPayload.title).toBe("Job Cancelled");
    expect(notificationPayload.message).toContain("Landing Page Redesign");
  });

  it("snapshots applicants BEFORE cancelling, not after (the escrow is gone once cancelled)", async () => {
    const user = userEvent.setup();
    render(
      <JobManagement
        escrowId="1"
        isOpenJob={true}
        isClient={true}
        totalAmount="10000000"
        token="0xUSDC"
        milestones={[]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Cancel Job" }));
    await screen.findByText("Cancel This Job?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel Job" }));

    await waitFor(() => expect(cancelJobMock).toHaveBeenCalled());
    const applicantsFetchOrder = getApplicationDetailsMock.mock.invocationCallOrder[0];
    const cancelOrder = cancelJobMock.mock.invocationCallOrder[0];
    expect(applicantsFetchOrder).toBeLessThan(cancelOrder);
  });
});

describe("JobManagement — Add Funds milestone picker displays whatever description it's given", () => {
  it("renders the milestone description passed in via props", async () => {
    const user = userEvent.setup();
    render(
      <JobManagement
        escrowId="1"
        isOpenJob={true}
        isClient={true}
        totalAmount="10000000"
        token="0xUSDC"
        milestones={[{ index: 0, description: "Build the responsive navbar", amount: "5000000" }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /add funds/i }));
    expect(await screen.findByText("Build the responsive navbar")).toBeInTheDocument();
  });
});
