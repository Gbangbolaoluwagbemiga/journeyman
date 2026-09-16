// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * EDITING A JOB NOBODY HAS STARTED.
 *
 * The client could add money to a milestone that already existed and could take
 * money off one, and that was all. Wanting a SECOND milestone meant cancelling
 * the job and posting it again — and cancellation is priced to discourage
 * exactly that: free three times, then 5%, 10%, 15%, plus a penalty scaled to
 * the applications already received. Deciding a job needs one more stage is not
 * abuse, and should not cost a client their fee.
 *
 * Wholesale replacement is only safe because nothing has started. Every
 * milestone is NotStarted, so no index is in flight for submit, approve or
 * dispute to be silently re-pointed by — which is the trap that makes editing
 * an array of milestones dangerous at any other moment in a job's life. These
 * tests are mostly about the moments when it must refuse.
 */
contract SetMilestonesTest is JobManagerBase {
    function _amounts(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory out) {
        uint256 n = c == type(uint256).max ? (b == type(uint256).max ? 1 : 2) : 3;
        out = new uint256[](n);
        out[0] = a;
        if (n > 1) out[1] = b;
        if (n > 2) out[2] = c;
    }

    function _reqs(uint256 n) internal pure returns (string[] memory out) {
        out = new string[](n);
        for (uint256 i; i < n; ++i) out[i] = "stage";
    }

    uint256 constant NONE = type(uint256).max;

    /* ─────────────── The thing it was built for ─────────────── */

    function test_clientCanAddAThirdMilestone() public {
        uint256 id = _createOpenJob(); // 300 + 600 = 900
        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.setMilestones(id, _amounts(M1, M2, 100e6), _reqs(3));

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        assertEq(ms.length, 3, "a third stage exists");
        assertEq(sf.getEscrow(id).totalAmount, 1000e6, "total grew by the new stage");
        // 100 for the work, 2.5 in fee.
        assertEq(before - usdc.balanceOf(client), 102_500_000, "paid for the addition and its fee");
    }

    function test_clientCanRemoveAMilestoneAndIsRefunded() public {
        uint256 id = _createOpenJob();
        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.setMilestones(id, _amounts(M1, NONE, NONE), _reqs(1));

        assertEq(sf.getMilestones(id).length, 1);
        assertEq(sf.getEscrow(id).totalAmount, M1);
        // 600 back, plus the 15 fee that was charged on it.
        assertEq(usdc.balanceOf(client) - before, 615_000_000, "refunded the work and its fee");
    }

    function test_clientCanReshuffleWithoutMovingMoney() public {
        uint256 id = _createOpenJob();
        uint256 before = usdc.balanceOf(client);

        vm.prank(client);
        sf.setMilestones(id, _amounts(M2, M1, NONE), _reqs(2)); // same total, swapped

        assertEq(sf.getEscrow(id).totalAmount, BUDGET);
        assertEq(usdc.balanceOf(client), before, "nothing moved");
        assertEq(sf.getMilestones(id)[0].amount, M2, "order is the client's to set");
    }

    function test_theNewStagesCarryTheirRequirements() public {
        uint256 id = _createOpenJob();
        string[] memory reqs = new string[](2);
        reqs[0] = "Three concepts, one refined";
        reqs[1] = "Source files and a usage guide";

        vm.prank(client);
        sf.setMilestones(id, _amounts(M1, M2, NONE), reqs);

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        assertEq(ms[0].requirements, "Three concepts, one refined");
        assertEq(ms[1].requirements, "Source files and a usage guide");
        // description is the freelancer's submission text and must start empty.
        assertEq(bytes(ms[0].description).length, 0);
    }

    /**
     * THE SAME JOB, THE OTHER WAY ROUND.
     *
     * addJobFunds still exists — it was removed to make room, put back once
     * deduplicating the Milestone struct literal made room, and kept because it
     * is the SAFER of the two for what it does. It takes a delta, so it cannot
     * drop a stage; setMilestones takes the whole list, so a caller working
     * from a stale read can.
     *
     * This asserts they agree on the arithmetic, so the narrow call staying
     * around never becomes a second, subtly different answer.
     */
    function test_theTwoRoutesAgreeOnToppingUpAStage() public {
        // addJobFunds(id, 10e6, 0) and the equivalent list rewrite must leave
        // the escrow in the same state and cost the client the same.
        uint256 viaDelta = _createOpenJob();
        uint256 beforeDelta = usdc.balanceOf(client);
        vm.prank(client);
        sf.addJobFunds(viaDelta, 10e6, 0);
        uint256 spentViaDelta = beforeDelta - usdc.balanceOf(client);

        uint256 viaList = _createOpenJob();
        uint256 beforeList = usdc.balanceOf(client);
        vm.prank(client);
        sf.setMilestones(viaList, _amounts(M1 + 10e6, M2, NONE), _reqs(2));
        uint256 spentViaList = beforeList - usdc.balanceOf(client);

        assertEq(spentViaDelta, spentViaList, "same cost");
        assertEq(
            sf.getEscrow(viaDelta).totalAmount,
            sf.getEscrow(viaList).totalAmount,
            "same total"
        );
        assertEq(sf.getMilestones(viaDelta)[0].amount, sf.getMilestones(viaList)[0].amount);
        assertEq(sf.getMilestones(viaDelta)[1].amount, sf.getMilestones(viaList)[1].amount);
    }

    function test_toppingUpOneMilestone_whatAddJobFundsDid() public {
        uint256 id = _createOpenJob(); // 300 + 600
        uint256 before = usdc.balanceOf(client);

        // The old call was addJobFunds(id, 10e6, 0). The new one says the same
        // thing by sending the list back with stage one raised by 10.
        vm.prank(client);
        sf.setMilestones(id, _amounts(M1 + 10e6, M2, NONE), _reqs(2));

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        assertEq(ms.length, 2, "still two stages");
        assertEq(ms[0].amount, M1 + 10e6, "the topped-up stage");
        assertEq(ms[1].amount, M2, "the other stage is untouched");
        assertEq(sf.getEscrow(id).totalAmount, BUDGET + 10e6);
        // 10 for the work and 0.25 in fee — the same arithmetic addJobFunds did.
        assertEq(before - usdc.balanceOf(client), 10_250_000);
    }

    /* ─────────────── Who may, and when ─────────────── */

    function test_onlyTheDepositorMayEdit() public {
        uint256 id = _createOpenJob();

        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setMilestones(id, _amounts(M1, NONE, NONE), _reqs(1));
    }

    function test_theJobManagerMayNotEdit() public {
        // The one-way key: Autopilot runs the job, and rewriting what the job
        // IS — or what it costs — was never part of that.
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.setMilestones(id, _amounts(M1, NONE, NONE), _reqs(1));
    }

    function test_refusesOnceWorkHasStarted() public {
        // The whole safety argument. After startWork somebody is relying on the
        // stages as written, and an index may be in flight.
        uint256 id = _liveAutopilotJob();

        vm.prank(client);
        vm.expectRevert(Atelier.CannotCancelAssignedJob.selector);
        sf.setMilestones(id, _amounts(M1, NONE, NONE), _reqs(1));
    }

    /* ─────────────── Shapes it must refuse ─────────────── */

    function test_refusesAnEmptyList() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        vm.expectRevert(Atelier.InvalidConfig.selector);
        sf.setMilestones(id, new uint256[](0), new string[](0));
    }

    function test_refusesMismatchedLengths() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        vm.expectRevert(Atelier.InvalidConfig.selector);
        sf.setMilestones(id, _amounts(M1, M2, NONE), _reqs(1));
    }

    function test_refusesAZeroTotal() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        vm.expectRevert(Atelier.InvalidAmount.selector);
        sf.setMilestones(id, _amounts(0, NONE, NONE), _reqs(1));
    }

    function test_refusesEtherOnAnErc20Job() public {
        uint256 id = _createOpenJob();
        vm.deal(client, 1 ether);
        vm.prank(client);
        vm.expectRevert(Atelier.InvalidAmount.selector);
        sf.setMilestones{value: 1}(id, _amounts(M1, M2, NONE), _reqs(2));
    }

    /* ─────────────── The books still balance ─────────────── */

    function test_theEscrowHoldsExactlyWhatTheStagesSayAfterEditing() public {
        uint256 id = _createOpenJob();
        uint256 heldBefore = usdc.balanceOf(address(sf));

        vm.prank(client);
        sf.setMilestones(id, _amounts(M1, M2, 100e6), _reqs(3));

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        uint256 sum;
        for (uint256 i; i < ms.length; ++i) sum += ms[i].amount;
        assertEq(sum, sf.getEscrow(id).totalAmount, "milestones sum to the total");
        // The contract holds the extra work plus the extra fee.
        assertEq(usdc.balanceOf(address(sf)) - heldBefore, 102_500_000);
    }

    function test_aFreelancerCanStillBeHiredAndPaidOnTheEditedJob() public {
        // The point of all of it: the job still works afterwards.
        uint256 id = _createOpenJob();

        vm.prank(client);
        sf.setMilestones(id, _amounts(M1, M2, 100e6), _reqs(3));

        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(worker);
        sf.submitMilestone(id, 2, "the third stage, which did not exist before");
        vm.prank(client);
        sf.approveMilestone(id, 2);

        assertEq(usdc.balanceOf(worker), 100e6, "paid for the stage the client added");
    }
}
