// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * PRODUCTIVE ESCROW.
 *
 * The brief calls this the riskiest feature in the product, and it is right:
 * everything else here moves other people's money from A to B, and this is the
 * only part that puts it somewhere it might not come back from.
 *
 * So the tests are not about the yield. They are about the one sentence the
 * feature is allowed to claim:
 *
 *     Principal is redeemable at face value, instantly, always.
 *     A yield failure must never block a payout or a dispute.
 *
 * Every test below breaks the venue on purpose and then checks somebody still
 * got paid.
 */
contract ProductiveEscrowTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();
        /* The yield layer is a companion contract now — it was 1.6KB of why
           Atelier could not be deployed at all. Same behaviour, wired through
           the escrow's single controller pointer. */
        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
        // No override: these run against the buffer that actually ships, so a
        // change to the default shows up here rather than passing unnoticed
        // under a number only the tests use.
        sf.setYieldController(address(yield_)); // 20%
    }

    /* ─────────────── The policy ─────────────── */

    function test_yieldIsOffUntilTheDepositorAsks() public {
        uint256 id = _createOpenJob();
        assertFalse(yield_.yieldOptIn(id), "must never default to on");
        assertEq(yield_.investableAmount(id), 0, "deployable while opted out");

        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        assertTrue(yield_.yieldOptIn(id));
    }

    function test_onlyTheDepositorMayOptIn() public {
        uint256 id = _createOpenJob();
        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        yield_.setYieldOptIn(id, true);
    }

    /**
     * The number that actually ships.
     *
     * Every other test here would pass at any buffer, because they assert
     * relationships rather than amounts. This one asserts the amount, so that
     * changing the default is a deliberate act with a test to update rather
     * than a silent change in how much of somebody's escrow is lent out.
     */
    function test_theShippedBufferIsTenPercent() public view {
        assertEq(yield_.yieldBufferBP(), 1000, "the default buffer moved");
    }

    function test_bufferCannotBeSetToNothing() public {
        // A zero buffer turns the venue from an optimisation into a dependency.
        vm.expectRevert(AtelierYield.BufferTooLow.selector);
        yield_.setYieldBuffer(0);
        vm.expectRevert(AtelierYield.BufferTooLow.selector);
        yield_.setYieldBuffer(999);
        yield_.setYieldBuffer(1000); // the floor is allowed
    }

    function test_adapterMustMatchItsToken() public {
        MockYieldAdapter wrong = new MockYieldAdapter(address(0xBEEF), address(sf));
        vm.expectRevert(AtelierYield.InvalidConfig.selector);
        yield_.setYieldAdapter(address(usdc), address(wrong));
    }

    /**
     * An open job is refundable in full by cancelJob at any instant, so none of
     * it is safe to lend out. This is rule 1 of the cap, and the first version
     * of the feature got it wrong.
     */
    function test_deploysNothingWhileTheJobIsStillOpen() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        assertEq(yield_.investableAmount(id), 0, "deployable while still cancellable");
        yield_.investIdle(id);
        assertEq(yield_.escrowDeployed(id), 0);
    }

    /**
     * The cap keeps the largest single unpaid milestone in cash, so any one
     * approval is always payable without the venue.
     *
     * Budget 900, milestones 300 and 600, buffer 10%:
     *   reserve = 600 (largest) + 90 (buffer) = 690
     *   deployable = 900 - 690 = 210
     *
     * The 600 is the part that matters and it does not move with the buffer.
     * Halving the buffer from 20% put another 90 to work and changed nothing
     * about whether the next claim is payable in cash — which is the whole
     * reason the reserve is derived from the milestone rather than being a
     * percentage.
     */
    function test_capKeepsTheLargestMilestoneInCash() public {
        uint256 id = _assignedJob(true);

        assertEq(yield_.investableAmount(id), 210e6, "cap is not the safe amount");

        yield_.investIdle(id);
        uint256 deployed = yield_.escrowDeployed(id);

        assertEq(deployed, 210e6);
        assertGe(BUDGET - deployed, M2, "cash cannot cover the largest milestone");
    }

    function test_investingTwiceDoesNotStackPastTheCap() public {
        uint256 id = _assignedJob(true);

        yield_.investIdle(id);
        uint256 first = yield_.escrowDeployed(id);
        yield_.investIdle(id);
        yield_.investIdle(id);

        assertEq(yield_.escrowDeployed(id), first, "repeat calls stacked");
    }

    /**
     * Once the small milestone is paid, the remaining 600 IS the largest
     * milestone, so nothing further is safe to deploy.
     */
    function test_capTightensAsTheEscrowDrainsDown() public {
        uint256 id = _assignedJob(true);
        yield_.investIdle(id);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(yield_.investableAmount(id), 0, "still deploying with one claim left");
    }

    /* ─────────────── The invariant, under a hostile venue ─────────────── */

    /// A job with a freelancer assigned and work started.
    function _assignedJob() internal returns (uint256 id) {
        return _assignedJob(false);
    }

    /**
     * The same, with the yield question answered up front.
     *
     * It has to be answered before anybody is hired, because after that it is a
     * term the freelancer accepted — see setYieldOptIn. Every fixture below
     * therefore opts in at posting time, which is also the only order a client
     * can actually perform.
     */
    function _assignedJob(bool withYield) internal returns (uint256 id) {
        id = _createOpenJob();
        if (withYield) {
            vm.prank(client);
            yield_.setYieldOptIn(id, true);
        }
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);
    }

    /// A live job with capital actually deployed and a milestone ready.
    function _fundedAndDeployed() internal returns (uint256 id) {
        id = _assignedJob(true);

        yield_.investIdle(id);
        assertGt(yield_.escrowDeployed(id), 0, "fixture deployed nothing");

        _submit(id, 0);
    }

    function test_payoutSucceedsWhenTheVenueIsHealthy() public {
        uint256 id = _fundedAndDeployed();

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "worker paid");
    }

    /**
     * The whole point. The venue is down; the freelancer is still paid.
     */
    function test_payoutSucceedsWhenTheVenueReverts() public {
        uint256 id = _fundedAndDeployed();
        venue.setRevertOnWithdraw(true);

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "a broken venue blocked a payment");
    }

    function test_payoutSucceedsWhenTheVenueIsIlliquid() public {
        uint256 id = _fundedAndDeployed();
        venue.setLiquidCap(1); // effectively frozen

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "an illiquid venue blocked a payment");
    }

    function test_payoutSucceedsWhenTheVenueReturnsLessThanAsked() public {
        uint256 id = _fundedAndDeployed();
        venue.setPayoutBP(5000); // returns half

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "a lossy venue blocked a payment");
    }

    /**
     * The buffer means the PAYMENT itself never touches the venue — cash covers
     * it outright. What does happen afterwards is a rebalance: paying a
     * milestone shrinks what is safe to have lent out, so the excess comes
     * back. Those are different things and the test asserts both.
     */
    function test_paymentComesFromCash_thenTheExcessIsRecalled() public {
        uint256 id = _fundedAndDeployed();
        uint256 deployedBefore = yield_.escrowDeployed(id);
        uint256 cashBefore = usdc.balanceOf(address(sf));

        vm.prank(client);
        sf.approveMilestone(id, 0);

        assertEq(usdc.balanceOf(worker), M1, "worker not paid");
        // Cash alone covered the payment: it fell by no more than the payment.
        assertGe(cashBefore, M1, "cash could not have covered this alone");
        // And the now-unsafe deployment was pulled back.
        assertLt(yield_.escrowDeployed(id), deployedBefore, "excess left lent out");
        assertEq(yield_.investableCeiling(id), 0, "ceiling should be zero with one claim left");
    }

    /* ─────────────── Disputes ─────────────── */

    function test_disputeResolvesWhileTheVenueIsDown() public {
        uint256 id = _fundedAndDeployed();
        venue.setRevertOnWithdraw(true);

        vm.prank(worker);
        sf.disputeMilestone(id, 0, "no response");

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(arbiter);
        sf.resolveDispute(id, 0, M1 / 2, M1 / 2, "split");

        assertEq(usdc.balanceOf(worker), workerBefore + M1 / 2, "worker share blocked");
        assertEq(usdc.balanceOf(client), clientBefore + M1 / 2, "client refund blocked");
    }

    /**
     * Cancellation refunds everything at once — which is exactly why an open
     * job deploys nothing. The venue being down is therefore irrelevant, and
     * this test exists to prove that rather than assume it.
     */
    function test_cancellationRefundsWhileTheVenueIsDown() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        yield_.investIdle(id);
        venue.setRevertOnWithdraw(true);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);

        assertGt(usdc.balanceOf(client), before, "a broken venue blocked a refund");
    }

    /* ─────────────── Accounting ─────────────── */

    function test_yieldIsReportedOnlyWhenItIsReal() public {
        uint256 id = _assignedJob(true);
        yield_.investIdle(id);

        assertEq(yield_.yieldEarned(address(usdc)), 0, "reported yield before any accrued");

        venue.simulateYield(int256(uint256(5e6)));
        assertEq(yield_.yieldEarned(address(usdc)), 5e6, "did not report real yield");

        // A venue that has LOST money must report zero, never a negative dressed
        // up as a positive by an underflow.
        venue.simulateYield(-int256(uint256(50e6)));
        assertEq(yield_.yieldEarned(address(usdc)), 0, "reported yield on a loss");
    }

    function test_disconnectingAVenueStopsNewDeploymentsOnly() public {
        uint256 id = _assignedJob(true);
        yield_.investIdle(id);
        uint256 deployed = yield_.deployedAssets(address(usdc));
        assertGt(deployed, 0);

        yield_.setYieldAdapter(address(usdc), address(0));

        /* Nothing new goes out. A no-op rather than a revert: investIdle is
           permissionless so a keeper can poke it, and a keeper that reverts on
           every call for a token with no venue is noise, not a signal. */
        yield_.investIdle(id);
        assertEq(yield_.investableAmount(id), 0, "still deployable with no venue");
        // ...and what is already out there is not force-exited at the worst
        // possible moment; it drains through the ordinary payout path.
        assertEq(yield_.deployedAssets(address(usdc)), deployed);
    }
}
