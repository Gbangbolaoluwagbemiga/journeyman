// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * A dispute settles one milestone. It does not settle the job.
 *
 * That gap trapped money. After arbitration the escrow returned to InProgress
 * with every remaining milestone still funded and no way to reach it: cancelJob
 * and withdrawJobFunds both refused a job with a freelancer on it, and
 * disputeMilestone refuses a milestone nobody has submitted. A client whose
 * working relationship had just been to an arbiter could do nothing but wait
 * out the deadline plus the emergency delay.
 *
 * The rule these tests pin: once a dispute has been settled, the client may
 * take back milestones NOBODY HAS STARTED, and nothing else.
 */
contract PostDisputeExitTest is JobManagerBase {
    /// Job funded, worker hired and started, milestone 0 submitted and disputed.
    function _disputedJob() internal returns (uint256 escrowId) {
        escrowId = _createOpenJob();
        _apply(escrowId, worker);

        vm.prank(client);
        sf.acceptFreelancer(escrowId, worker);

        vm.prank(worker);
        sf.startWork(escrowId);

        _submit(escrowId, 0);

        vm.prank(worker);
        sf.disputeMilestone(escrowId, 0, "It meets every criterion listed");
    }

    /// Split milestone 0 down the middle and let the escrow return to InProgress.
    function _resolve(uint256 escrowId) internal {
        vm.prank(arbiter);
        sf.resolveDispute(escrowId, 0, M1 / 2, M1 - M1 / 2, "Half each");
    }

    /* ─────────── the bug ─────────── */

    function test_clientCanTakeBackAnUnstartedMilestoneAfterArbitration() public {
        uint256 id = _disputedJob();
        _resolve(id);

        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        // The budget comes back, and so does the platform fee charged on it.
        uint256 refunded = usdc.balanceOf(client) - before;
        assertGe(refunded, M2, "client did not get the unstarted milestone back");

        assertEq(sf.getMilestones(id)[1].amount, 0, "milestone still carries a budget");
    }

    /// The escrow closes once nothing is left owing.
    function test_theJobEndsWhenNothingIsLeftToPay() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(esc.totalAmount, esc.paidAmount, "escrow still owes something");
    }

    /* ─────────── and the limits on it ─────────── */

    /**
     * The check that makes this fair rather than a way to renege.
     *
     * A submitted milestone is work that has arrived. It goes through review or
     * arbitration like anything else — it is not the client's to withdraw.
     */
    function test_cannotTakeBackWorkTheFreelancerHasAlreadySubmitted() public {
        uint256 id = _disputedJob();
        _resolve(id);

        _submit(id, 1); // the freelancer delivers the second milestone

        vm.prank(client);
        vm.expectRevert(Atelier.MilestoneAlreadyProcessed.selector);
        sf.withdrawJobFunds(id, M2, 1);
    }

    /// No arbitration, no exit. This is not a way to walk away mid-job.
    function test_cannotTakeBackFundsFromAJobThatWasNeverDisputed() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);

        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(Atelier.CannotCancelAssignedJob.selector);
        sf.withdrawJobFunds(id, M2, 1);
    }

    /// Only the client. Not the freelancer, not the agent, not a passer-by.
    function test_onlyTheClientMayTakeItBack() public {
        uint256 id = _disputedJob();
        _resolve(id);

        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? worker : i == 1 ? manager : outsider;
            vm.prank(who);
            vm.expectRevert(Atelier.Unauthorized.selector);
            sf.withdrawJobFunds(id, M2, 1);
        }
    }

    /// The pre-hire path this shares code with must still behave.
    function test_openJobFundManagementStillWorks() public {
        uint256 id = _createOpenJob();

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        assertGe(usdc.balanceOf(client) - before, M2, "pre-hire withdrawal broke");
    }
}

/**
 * The other option after arbitration: hand the rest of the job on.
 *
 * A dispute means this client and this freelancer are done. It does not mean
 * the work stopped being worth doing, and the client may want it finished
 * rather than refunded. What makes that fair to whoever picks it up is that
 * nothing is erased — they can read what was delivered, what the disagreement
 * was, and how the arbiter settled it, before deciding to take it on.
 */
contract ReopenAfterDisputeTest is JobManagerBase {
    /// Same setup as the sibling suite. Duplicated rather than inherited, so
    /// its tests do not run a second time under this contract's name.
    function _disputedJob() internal returns (uint256 escrowId) {
        escrowId = _createOpenJob();
        _apply(escrowId, worker);
        vm.prank(client);
        sf.acceptFreelancer(escrowId, worker);
        vm.prank(worker);
        sf.startWork(escrowId);
        _submit(escrowId, 0);
        vm.prank(worker);
        sf.disputeMilestone(escrowId, 0, "It meets every criterion listed");
    }

    function _resolve(uint256 escrowId) internal {
        vm.prank(arbiter);
        sf.resolveDispute(escrowId, 0, M1 / 2, M1 - M1 / 2, "Half each");
    }

    function test_theJobGoesBackOnTheBoard() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.reopenJob(id);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertTrue(esc.isOpenJob, "not back on the board");
        assertEq(esc.beneficiary, address(0), "still assigned to the old freelancer");
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Pending), "not open for applications");
        assertFalse(esc.workStarted, "still marked as work in progress");
    }

    /// The whole point: the next person can see what happened here.
    function test_thePreviousWorkAndTheRulingSurvive() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.reopenJob(id);

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        assertGt(ms[0].submittedAt, 0, "the previous submission was erased");
        assertGt(bytes(ms[0].disputeReason).length, 0, "the disagreement was erased");
        assertGt(bytes(ms[0].resolutionReason).length, 0, "the arbiter's ruling was erased");
        assertGt(ms[0].resolvedAt, 0, "no record that this went to arbitration");
    }

    /// Paid work stays paid; only the untouched milestone is up for grabs.
    function test_theUnfinishedMilestoneIsStillFunded() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.reopenJob(id);

        assertEq(sf.getMilestones(id)[1].amount, M2, "the remaining budget went missing");
    }

    /// And a new freelancer can actually take it.
    function test_someoneElseCanPickItUpAndBePaid() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(client);
        sf.reopenJob(id);

        address newcomer = address(0xFEE15A);
        _apply(id, newcomer);

        vm.prank(client);
        sf.acceptFreelancer(id, newcomer);

        vm.prank(newcomer);
        sf.startWork(id);

        vm.prank(newcomer);
        sf.submitMilestone(id, 1, "Finished what the last one left");

        uint256 before = usdc.balanceOf(newcomer);
        vm.prank(client);
        sf.approveMilestone(id, 1);

        assertEq(usdc.balanceOf(newcomer) - before, M2, "the new freelancer was not paid");
    }

    /* ─────────── limits ─────────── */

    function test_cannotReopenAJobThatWasNeverDisputed() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(client);
        vm.expectRevert(Atelier.CannotCancelAssignedJob.selector);
        sf.reopenJob(id);
    }

    function test_cannotReopenWhenEveryMilestoneIsAlreadyDelivered() public {
        uint256 id = _disputedJob();
        _resolve(id);
        _submit(id, 1); // nothing left untouched

        vm.prank(client);
        vm.expectRevert(Atelier.NothingLeftToFinish.selector);
        sf.reopenJob(id);
    }

    function test_onlyTheClientMayReopen() public {
        uint256 id = _disputedJob();
        _resolve(id);

        vm.prank(worker);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.reopenJob(id);
    }
}
