// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * Ratings are the only signal a client has about a stranger, so the cost of
 * manufacturing one has to be higher than the cost of earning one.
 *
 * The cheapest forgery is a closed loop with yourself: fund an escrow, be your
 * own freelancer, release it, rate yourself five stars. The money comes back
 * minus the platform fee, and the resulting rating is byte-for-byte identical
 * on-chain to one a real client left. These tests close that loop at all three
 * points where it could be entered.
 *
 * WHAT THIS DOES NOT FIX, STATED PLAINLY
 *
 * Two wallets controlled by one person can still rate each other, and no
 * contract check can tell that apart from two strangers — it needs identity or
 * stake, neither of which exists here. What the guards below buy is that the
 * forgery now costs a second funded account and two sets of gas per fake
 * rating, instead of one account rating itself in a loop for free.
 */
contract SelfDealingTest is JobManagerBase {
    /// The direct path: name yourself the beneficiary at creation.
    function test_cannotCreateAnEscrowPayingYourself() public {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;

        uint256[] memory amounts = new uint256[](1);
        amounts[0] = BUDGET;

        string[] memory descs = new string[](1);
        descs[0] = "Only milestone";

        vm.prank(client);
        vm.expectRevert(Atelier.SelfDealing.selector);
        sf.createEscrow(
            client, address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    /// The open-job path: apply to your own posting and award it to yourself.
    function test_cannotAwardYourOwnOpenJobToYourself() public {
        uint256 escrowId = _createOpenJob();

        // Nothing stops the depositor applying — the application list is public
        // and permissionless on purpose. The award is where it has to fail.
        _apply(escrowId, client);

        vm.prank(client);
        vm.expectRevert(Atelier.SelfDealing.selector);
        sf.acceptFreelancer(escrowId, client);
    }

    /// An Autopilot manager cannot route the job back to the client either.
    function test_managerCannotAwardTheJobBackToTheDepositor() public {
        uint256 escrowId = _createOpenJob();

        vm.prank(client);
        sf.setJobManager(escrowId, manager);
        _apply(escrowId, client);

        vm.prank(manager);
        vm.expectRevert(Atelier.SelfDealing.selector);
        sf.acceptFreelancer(escrowId, client);
    }

    /// A real two-party job is untouched by any of the above.
    function test_hiringSomebodyElseStillWorks() public {
        uint256 escrowId = _createOpenJob();
        _apply(escrowId, worker);

        vm.prank(client);
        sf.acceptFreelancer(escrowId, worker);

        assertEq(sf.getEscrow(escrowId).beneficiary, worker, "a genuine hire was blocked");
    }

    /// The manager guard and the self-dealing guard are separate failures.
    function test_managerStillCannotHireItself() public {
        uint256 escrowId = _createOpenJob();

        vm.prank(client);
        sf.setJobManager(escrowId, manager);
        _apply(escrowId, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.ManagerCannotSelfHire.selector);
        sf.acceptFreelancer(escrowId, manager);
    }
}
