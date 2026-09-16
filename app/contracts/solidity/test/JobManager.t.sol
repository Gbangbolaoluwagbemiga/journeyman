// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * AUTOPILOT — the scoped job manager.
 *
 * These are the tests ADR 0001 said had to exist before the UI is allowed to
 * tell a client "the agent can pay the freelancer, it can never pay itself".
 * The claim is the product; without these it is marketing.
 *
 * They are deliberately written against the cases the feature was NOT designed
 * around — a manager trying to hire itself, a manager acting after revocation,
 * a manager reaching for the levers it was never given — because the happy path
 * was the part we already had in our heads while writing it.
 */
contract JobManagerTest is JobManagerBase {
    /* ─────────────── Appointment ─────────────── */

    function test_depositorCanAppointAndRevoke() public {
        uint256 id = _createOpenJob();

        vm.prank(client);
        sf.setJobManager(id, manager);
        assertEq(sf.jobManager(id), manager);
        assertTrue(sf.isJobManager(id, manager));

        vm.prank(client);
        sf.revokeJobManager(id);
        assertEq(sf.jobManager(id), address(0));
        assertFalse(sf.isJobManager(id, manager));
    }

    function test_onlyDepositorMayAppoint() public {
        uint256 id = _createOpenJob();

        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setJobManager(id, manager);

        // Not even the manager may re-appoint itself, which would otherwise let
        // a compromised agent survive its own revocation.
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setJobManager(id, outsider);
    }

    function test_managerCannotRevokeItself() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.revokeJobManager(id);
    }

    function test_rejectsZeroAndSelfAppointment() public {
        uint256 id = _createOpenJob();

        vm.prank(client);
        vm.expectRevert(Atelier.InvalidAddress.selector);
        sf.setJobManager(id, address(0));

        vm.prank(client);
        vm.expectRevert(Atelier.InvalidAddress.selector);
        sf.setJobManager(id, client);
    }

    function test_revokingWhenNoneSetReverts() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        vm.expectRevert(Atelier.NoManagerSet.selector);
        sf.revokeJobManager(id);
    }

    /* ─────────── ADR test 2 — the manager can never be the beneficiary ─────────── */

    function test_cannotAppointTheAssignedFreelancerAsManager() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(client);
        vm.expectRevert(Atelier.ManagerCannotBeBeneficiary.selector);
        sf.setJobManager(id, worker);
    }

    /**
     * The attack the invariant exists to stop: appoint yourself manager of an
     * open job, apply as a freelancer, hire yourself, approve your own work.
     */
    function test_managerCannotHireItself() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        _apply(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.ManagerCannotSelfHire.selector);
        sf.acceptFreelancer(id, manager);
    }

    /**
     * The same guard has to hold when the CLIENT is the one accepting — a
     * depositor who hires their own agent as the worker would re-create the
     * conflict of interest by accident, and the contract should not let a
     * mistake produce a state the invariant forbids.
     */
    function test_depositorCannotHireTheManagerEither() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        _apply(id, manager);

        vm.prank(client);
        vm.expectRevert(Atelier.ManagerCannotSelfHire.selector);
        sf.acceptFreelancer(id, manager);
    }

    /* ─────────── ADR test 1 — a manager's approval pays the worker ─────────── */

    function test_managerApprovalPaysTheWorkerNotItself() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 managerBefore = usdc.balanceOf(manager);

        vm.prank(manager);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), workerBefore + M1, "worker paid");
        assertEq(usdc.balanceOf(manager), managerBefore, "manager gained nothing");
    }

    function test_managerCanHireApproveAndReject() public {
        uint256 id = _liveAutopilotJob();

        _submit(id, 0);
        vm.prank(manager);
        sf.rejectMilestone(id, 0, "Not quite there");

        // Rejection sends it back rather than taking anything.
        assertEq(usdc.balanceOf(worker), 0);

        _submit(id, 0);
        vm.prank(manager);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1);
    }

    /* ─────────── ADR test 3 — the levers a manager was never given ─────────── */

    /**
     * The manager MAY escalate, and gains nothing by it.
     *
     * This used to assert the opposite. Denying it left an Autopilot job the
     * client funded themselves with no exit: the agent is the manager there,
     * not the depositor, so when its revision rounds ran out its escalation
     * reverted and the job stuck with nobody paid and nothing refunded. Its
     * only remaining moves were to approve work it had judged inadequate or
     * reject forever, both worse than asking a person.
     *
     * Escalating hands the decision away rather than taking it, so the one-way
     * key is untouched — which is what the balance assertions below are for.
     */
    function test_managerMayEscalateButGainsNothing() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        uint256 managerBefore = usdc.balanceOf(manager);
        uint256 escrowBefore = usdc.balanceOf(address(sf));

        vm.prank(manager);
        sf.disputeMilestone(id, 0, "revision rounds exhausted");

        assertEq(usdc.balanceOf(manager), managerBefore, "manager gained by escalating");
        assertEq(usdc.balanceOf(address(sf)), escrowBefore, "escrow moved on escalation");

        // Escalation freezes the job to the manager, exactly as a client's would.
        vm.prank(manager);
        vm.expectRevert(Atelier.EscrowNotActive.selector);
        sf.approveMilestone(id, 0);
    }

    function test_managerCannotExtendDeadline() public {
        uint256 id = _liveAutopilotJob();

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.extendDeadline(id, 5);
    }

    function test_managerCannotCancelJob() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.cancelJob(id);
    }

    function test_managerCannotMoveFunds() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.withdrawJobFunds(id, 10e6, 0);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.addJobFunds(id, 10e6, 0);

        // Every surface that can move a job's total, not just the one that
        // existed when this test was written. setMilestones can raise it too.
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 10e6;
        string[] memory reqs = new string[](1);
        reqs[0] = "manager tries to rewrite the job";
        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setMilestones(id, amounts, reqs);
    }

    /* ─────────── ADR test 4 — revocation bites immediately ─────────── */

    function test_revokedManagerCannotActOnItsVeryNextCall() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        vm.prank(client);
        sf.revokeJobManager(id);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.approveMilestone(id, 0);

        // And the client can still finish the job themselves.
        vm.prank(client);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1);
    }

    /**
     * Revocation must not be survivable by having been appointed earlier on a
     * different escrow. Authority is per-job, not per-address.
     */
    function test_managerAuthorityDoesNotLeakAcrossJobs() public {
        uint256 managed = _liveAutopilotJob();

        uint256 other = _createOpenJob();
        _apply(other, worker);
        vm.prank(client);
        sf.acceptFreelancer(other, worker);
        vm.prank(worker);
        sf.startWork(other);
        _submit(other, 0);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.approveMilestone(other, 0);

        // Still fine on the job it actually manages.
        _submit(managed, 0);
        vm.prank(manager);
        sf.approveMilestone(managed, 0);
    }

    /* ─────────── ADR test 5 — the depositor keeps everything ─────────── */

    function test_depositorRetainsEveryPowerWhileManagerIsSet() public {
        uint256 id = _liveAutopilotJob();

        vm.prank(client);
        sf.extendDeadline(id, 3);

        _submit(id, 0);

        vm.prank(client);
        sf.rejectMilestone(id, 0, "client overrides");

        _submit(id, 0);

        vm.prank(client);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1);

        _submit(id, 1);
        vm.prank(client);
        sf.disputeMilestone(id, 1, "client escalates");
    }

    /* ─────────── ADR test 6 — a dispute mid-Autopilot resolves normally ─────────── */

    function test_disputeDuringAutopilotStillResolves() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        vm.prank(worker);
        sf.disputeMilestone(id, 0, "client unresponsive");

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(arbiter);
        sf.resolveDispute(id, 0, M1 / 2, M1 / 2, "split");

        assertEq(usdc.balanceOf(worker), workerBefore + M1 / 2, "worker share");
        assertEq(usdc.balanceOf(client), clientBefore + M1 / 2, "client refund");
        assertEq(usdc.balanceOf(manager), 0, "manager still gained nothing");
    }

    /**
     * A yield or agent failure must never block a payout. Here the analogous
     * case: once escalated, the manager must not be able to reach in and
     * approve around the arbiter.
     */
    function test_managerCannotApproveADisputedMilestone() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        vm.prank(worker);
        sf.disputeMilestone(id, 0, "escalating");

        /*
         * Reverts with EscrowNotActive rather than MilestoneNotSubmitted: a
         * dispute moves the whole ESCROW to Disputed, so the status guard fires
         * before the per-milestone one. Worth pinning the exact error — it
         * records that escalation freezes the entire job to the agent, not just
         * the milestone under argument, which is the stronger guarantee and the
         * one a client is relying on.
         */
        vm.prank(manager);
        vm.expectRevert(Atelier.EscrowNotActive.selector);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(manager), 0, "manager gained nothing");
    }

    /* ─────────── Non-parties stay out ─────────── */

    function test_outsiderCanDoNothing() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        vm.startPrank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.approveMilestone(id, 0);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.rejectMilestone(id, 0, "no");
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setJobManager(id, outsider);
        vm.stopPrank();
    }
}
