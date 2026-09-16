// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * WHILE NOBODY HAS STARTED, THE MONEY IS STILL THE CLIENT'S.
 *
 * The cancel guard read `!isOpenJob`, which is false from the first block for a
 * job created with its freelancer already named — so that entire kind of job
 * could never be cancelled. A client's budget sat unreachable until the
 * deadline plus the emergency delay, on a job nobody had touched. The same
 * trapped-funds shape as the post-dispute bug, reached from another direction,
 * and no test noticed because every cancel fixture posted an open job.
 *
 * The second half matters just as much: for exactly as long as the client can
 * take their money back, all of it has to be there to take. So the yield
 * ceiling is tied to the same line — nothing is deployed until the freelancer
 * starts, because cancelling does not unwind and the escrow would be asked for
 * cash it had lent out.
 */
contract CancelBeforeWorkTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();
        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    /// A job created with its freelancer already named on it.
    function _assignedAtCreation() internal returns (uint256 id) {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = M1;
        amounts[1] = M2;
        string[] memory descs = new string[](2);
        descs[0] = "First milestone";
        descs[1] = "Second milestone";

        vm.prank(client);
        id = sf.createEscrow(
            worker, address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    /* ─────────── getting the money back ─────────── */

    function test_aDirectlyAssignedJobCanBeCancelledBeforeWorkStarts() public {
        uint256 id = _assignedAtCreation();
        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.cancelJob(id);

        assertGt(usdc.balanceOf(client), before, "the client got nothing back");
    }

    function test_anOpenJobStillCancels() public {
        uint256 id = _createOpenJob();
        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);
        assertGt(usdc.balanceOf(client), before);
    }

    /**
     * The cost of the rule, stated as a test rather than left implicit: a
     * freelancer who was accepted and has not started can be dropped. Weighed
     * against a client's money being unreachable for a fortnight on a job that
     * never began, this is the better failure — but it is a real one.
     */
    function test_aHiredFreelancerWhoHasNotStartedCanBeDropped() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(client);
        sf.cancelJob(id); // must not revert
    }

    /* ─────────── and losing the right to ─────────── */

    function test_onceWorkStartsTheClientCannotCancel() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(Atelier.CannotCancelAssignedJob.selector);
        sf.cancelJob(id);
    }

    function test_onlyTheDepositorMayCancel() public {
        uint256 id = _assignedAtCreation();
        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.cancelJob(id);
    }

    function test_theNamedFreelancerCannotCancelTheJob() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.cancelJob(id);
    }

    /* ─────────── the money is always all there ─────────── */

    /**
     * The rule this exists to hold: for as long as the client can cancel,
     * nothing has been lent out. Otherwise a refund asks the escrow for cash it
     * does not have, and cancelling does not unwind the position.
     */
    function test_nothingIsDeployedWhileTheJobIsStillCancellable() public {
        uint256 id = _assignedAtCreation();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        yield_.investIdle(id);
        assertEq(yield_.escrowDeployed(id), 0, "lent out money the client can still reclaim");
        assertEq(yield_.investableCeiling(id), 0, "ceiling is non-zero before work starts");
    }

    function test_aFullRefundIsAvailableOnAnOptedInJob() public {
        uint256 id = _assignedAtCreation();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        yield_.investIdle(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        // Whatever the cancellation penalty, it comes out of the budget — not
        // out of money that is somewhere else.
        assertGt(usdc.balanceOf(client) - before, 0, "refund failed on an opted-in job");
    }

    /// And it starts working the moment the freelancer does.
    function test_capitalDeploysAsSoonAsWorkBegins() public {
        uint256 id = _assignedAtCreation();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        vm.prank(worker);
        sf.startWork(id);

        yield_.investIdle(id);
        assertGt(yield_.escrowDeployed(id), 0, "work started and nothing was deployed");
    }
}

/**
 * A NAMED FREELANCER'S RIGHT TO SAY NO.
 *
 * Direct assignment puts somebody's name on a job they never agreed to. Their
 * only exits were to ignore it — leaving the client waiting on someone who was
 * never coming — or to start work they did not want. Neither of those is
 * consent, and one of them is how a client's money ends up locked for a
 * fortnight.
 */
contract DeclineAssignmentTest is JobManagerBase {
    function _assignedAtCreation() internal returns (uint256 id) {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = M1;
        amounts[1] = M2;
        string[] memory descs = new string[](2);
        descs[0] = "First milestone";
        descs[1] = "Second milestone";
        vm.prank(client);
        id = sf.createEscrow(
            worker, address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    function test_theNamedFreelancerCanHandTheJobBack() public {
        uint256 id = _assignedAtCreation();

        vm.prank(worker);
        sf.declineAssignment(id);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(esc.beneficiary, address(0), "still named on a job they declined");
    }

    /**
     * A decline does not decide what happens next. The money stays put and the
     * job waits, because the client is the one who knows whether they want to
     * meet the freelancer's terms, take anyone, or have their deposit back.
     */
    function test_aDeclineLeavesTheJobWaitingOnTheClient() public {
        uint256 id = _assignedAtCreation();
        uint256 held = usdc.balanceOf(address(sf));

        vm.prank(worker);
        sf.declineAssignment(id);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertFalse(esc.isOpenJob, "put itself on the board without being asked");
        assertEq(usdc.balanceOf(address(sf)), held, "money moved on a decline");
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Pending));
    }

    /* ─────────── the client's three answers ─────────── */

    /**
     * ONE: meet their terms and ask them again.
     *
     * The decline records them as an applicant, so the client can name them
     * without making them apply for a job they were already offered. Whatever
     * the reason was — a budget, a deadline — the client fixes it and re-offers.
     */
    function test_theClientCanTopUpAndNameTheSameFreelancerAgain() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.declineAssignment(id);

        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        assertEq(sf.getEscrow(id).beneficiary, worker, "could not re-offer the job");
    }

    /// TWO: put it on the board and let anyone apply.
    function test_theClientCanOpenItToEveryone() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.declineAssignment(id);

        vm.prank(client);
        sf.reopenJob(id);
        assertTrue(sf.getEscrow(id).isOpenJob, "did not go back on the board");

        _apply(id, outsider);
        vm.prank(client);
        sf.acceptFreelancer(id, outsider);
        assertEq(sf.getEscrow(id).beneficiary, outsider, "the reopened job could not be filled");
    }

    /// THREE: take the money back.
    function test_theClientCanTakeTheirMoneyBack() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.declineAssignment(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);
        assertGt(usdc.balanceOf(client), before, "no refund after a decline");
    }

    /* Only the client picks among the three. */
    function test_aStrangerCannotOpenTheJob() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.declineAssignment(id);

        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.reopenJob(id);
    }

    /* ─────────── who may, and when ─────────── */

    function test_onlyTheNamedFreelancerMayDecline() public {
        uint256 id = _assignedAtCreation();
        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.declineAssignment(id);
    }

    /* The client has cancelJob; declining on their behalf would let them strip a
       freelancer off a job while pretending the freelancer chose to leave. */
    function test_theClientCannotDeclineForThem() public {
        uint256 id = _assignedAtCreation();
        vm.prank(client);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.declineAssignment(id);
    }

    function test_youCannotDeclineWorkYouHaveAlreadyStarted() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(worker);
        vm.expectRevert(Atelier.WorkAlreadyStarted.selector);
        sf.declineAssignment(id);
    }

    function test_decliningTwiceIsNotPossible() public {
        uint256 id = _assignedAtCreation();
        vm.prank(worker);
        sf.declineAssignment(id);

        vm.prank(worker);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.declineAssignment(id);
    }
}

/**
 * WHAT IT COSTS TO WALK AWAY FROM A JOB NOBODY STARTED.
 *
 * The cancellation fee is there so a client cannot waste people's time: post a
 * job, let freelancers write applications, pull it. That is a real cost and it
 * should be paid.
 *
 * It was also being charged to a client stranded by a freelancer who was named,
 * never started, and never would — 5% of their own budget for somebody else's
 * silence. Nobody had applied to that job. Nobody had spent anything.
 */
contract CancellationCostTest is JobManagerBase {
    function _assignedAtCreation() internal returns (uint256 id) {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = M1;
        amounts[1] = M2;
        string[] memory descs = new string[](2);
        descs[0] = "First milestone";
        descs[1] = "Second milestone";
        vm.prank(client);
        id = sf.createEscrow(
            worker, address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    /** Past the free tier, so a penalty would otherwise apply. */
    function _useUpTheFreeCancellations() internal {
        for (uint256 i; i < 3; ++i) {
            uint256 id = _createOpenJob();
            vm.prank(client);
            sf.cancelJob(id);
        }
    }

    function test_aGhostedClientGetsEveryCentBack() public {
        _useUpTheFreeCancellations();
        uint256 id = _assignedAtCreation();

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        // Budget plus the platform fee, whole. The freelancer never started and
        // nobody applied, so there is nothing anyone can charge for.
        assertEq(
            usdc.balanceOf(client) - before,
            BUDGET + (BUDGET * 250) / 10000,
            "charged for being let down"
        );
    }

    /**
     * And the fee still bites where it was meant to. Somebody wrote an
     * application for this job; pulling it after that is not free.
     */
    function test_aClientWhoWastedApplicantsTimeStillPays() public {
        _useUpTheFreeCancellations();
        uint256 id = _createOpenJob();
        _apply(id, worker);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        assertLt(
            usdc.balanceOf(client) - before,
            BUDGET + (BUDGET * 250) / 10000,
            "cancelling on applicants became free"
        );
    }

    /**
     * The applicant fee is not a tier, and does not have a free allowance.
     *
     * The base tier forgives a client's first two cancellations, because plans
     * change and a marketplace that punishes the first mistake is not one
     * people post on. The 5% for having applicants is charged from the very
     * first one, because it is not about the client's record — it is about the
     * person who wrote an application that just became worthless.
     *
     * Written down because the two read as one fee and are not, and because I
     * assumed otherwise while writing these tests.
     */
    function test_theApplicantFeeAppliesFromTheFirstCancellation() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        uint256 fullRefund = BUDGET + (BUDGET * 250) / 10000;
        assertEq(
            usdc.balanceOf(client) - before,
            fullRefund - (BUDGET * 5) / 100,
            "one applicant should cost 5%, tier or no tier"
        );
    }

    /* But with nobody applied, the first cancellation is genuinely free. */
    function test_anUntouchedJobCostsNothingToPullDown() public {
        uint256 id = _createOpenJob();

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        assertEq(usdc.balanceOf(client) - before, BUDGET + (BUDGET * 250) / 10000);
    }
}
