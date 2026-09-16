// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "../src/yield/AtelierYield.sol";
import "../src/yield/SponsoredVault.sol";

/**
 * THE VENUE WE ARE ACTUALLY POINTING LIVE TESTNET ESCROW AT.
 *
 * {SponsoredVault} custodies real money belonging to real freelancers on Arc
 * testnet, so the bar is not "does the demo work". It is: can anybody other
 * than the vault get a cent out of it, ever, by any path.
 *
 * The answer has to be no, including for us. Every rescue hatch is also a rug,
 * and the thing being rescued would be somebody's unpaid milestone.
 */
contract SponsoredVaultTest is JobManagerBase {
    AtelierYield internal yield_;
    SponsoredVault internal venue;

    address internal sponsorAddr = address(0x5900);

    function setUp() public override {
        super.setUp();
        yield_ = new AtelierYield(address(sf));
        venue = new SponsoredVault(address(usdc), address(yield_));

        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    /* ─────────── nobody but the vault ─────────── */

    function test_aStrangerCannotDepositIntoIt() public {
        deal(address(usdc), outsider, 100e6);
        vm.startPrank(outsider);
        usdc.approve(address(venue), 100e6);
        vm.expectRevert(SponsoredVault.NotVault.selector);
        venue.deposit(100e6);
        vm.stopPrank();
    }

    function test_aStrangerCannotWithdrawFromIt() public {
        _sponsor(100e6);
        vm.prank(outsider);
        vm.expectRevert(SponsoredVault.NotVault.selector);
        venue.withdraw(1e6);
    }

    /**
     * The one that matters most: sponsorship is a gift, not a loan. If a
     * sponsor could pull it back they could do so between an escrow deploying
     * and a milestone being approved, and a freelancer would go unpaid.
     */
    function test_theSponsorCannotTakeItBack() public {
        _sponsor(100e6);
        vm.prank(sponsorAddr);
        vm.expectRevert(SponsoredVault.NotVault.selector);
        venue.withdraw(100e6);
        assertEq(venue.totalAssets(), 100e6, "sponsorship left the vault");
    }

    /* ─────────── the interface's one hard rule ─────────── */

    function test_withdrawReturnsExactlyWhatWasAsked() public {
        uint256 id = _earningJob();
        uint256 deployed = yield_.escrowDeployed(id);
        assertGt(deployed, 0, "nothing was deployed, so nothing is under test");

        uint256 before = usdc.balanceOf(address(yield_));
        vm.prank(address(yield_));
        uint256 got = venue.withdraw(deployed);

        assertEq(got, deployed, "reported a different number than it paid");
        assertEq(usdc.balanceOf(address(yield_)) - before, deployed, "paid the wrong amount");
    }

    /// It must revert rather than pay less — a silent shortfall is a hole.
    function test_itRevertsRatherThanPayingLessThanAsked() public {
        _sponsor(10e6);
        vm.prank(address(yield_));
        vm.expectRevert(SponsoredVault.Insufficient.selector);
        venue.withdraw(11e6);
    }

    function test_itPaysTheVaultThatCalled_notTheEscrowBehindIt() public {
        _sponsor(50e6);
        uint256 escrowBefore = usdc.balanceOf(address(sf));

        vm.prank(address(yield_));
        venue.withdraw(50e6);

        assertEq(usdc.balanceOf(address(sf)), escrowBefore, "paid the escrow directly");
        assertEq(usdc.balanceOf(address(yield_)), 50e6, "the vault was not paid");
    }

    /* ─────────── the whole loop, on the venue we will deploy ─────────── */

    /**
     * Not a re-run of YieldDistribution.t.sol against a different mock: that
     * suite proves the waterfall's arithmetic, and this one proves the venue we
     * are actually deploying can carry it. The two have been wrong separately.
     */
    function test_aJobEarnsAndTheMoneyIsSplit() public {
        uint256 id = _earningJob();
        _sponsor(30e6); // the venue is now worth more than was put in

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);
        _finishRemaining(id);

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 clientBefore = usdc.balanceOf(client);
        uint256 platformBefore = usdc.balanceOf(feeCollector);

        yield_.distributeYield(id);

        assertGt(usdc.balanceOf(client), clientBefore, "the client's fee was not covered first");
        assertGt(usdc.balanceOf(worker), workerBefore, "the freelancer earned nothing");
        assertGt(
            usdc.balanceOf(worker) - workerBefore,
            usdc.balanceOf(feeCollector) - platformBefore,
            "the platform took more than the freelancer"
        );
    }

    /// The tag on the job card is driven by this number, so it has to move.
    /// The number the 🌱 tag on a job card reads. It has to actually move.
    function test_escrowDeployedGoesAboveZero_whichIsWhatTheTagReads() public {
        uint256 id = _createOpenJob();
        assertEq(yield_.escrowDeployed(id), 0, "deployed before anyone was hired");

        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        // Opted in, but an open job is refundable on demand, so still nothing.
        yield_.investIdle(id);
        assertEq(yield_.escrowDeployed(id), 0, "deployed while still cancellable");

        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        yield_.investIdle(id);
        assertGt(yield_.escrowDeployed(id), 0, "opted in, hired, and deployed nothing");
    }

    /**
     * A job posted without the choice can never acquire it.
     *
     * This is the point of the lock: a freelancer took the job on the terms
     * shown on the board, and "this escrow earns you a share" cannot appear
     * afterwards any more than it can disappear.
     */
    function test_aJobPostedWithoutYieldCanNeverGainIt() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(AtelierYield.TooLateToChoose.selector);
        yield_.setYieldOptIn(id, true);

        yield_.investIdle(id);
        assertEq(yield_.escrowDeployed(id), 0, "deployed on a job that never opted in");
    }

    /* ─────────── helpers ─────────── */

    function _sponsor(uint256 amount) internal {
        deal(address(usdc), sponsorAddr, amount);
        vm.startPrank(sponsorAddr);
        usdc.approve(address(venue), amount);
        venue.sponsor(amount);
        vm.stopPrank();
    }

    function _earningJob() internal returns (uint256 id) {
        id = _createOpenJob();
        // Answered at posting time, which is the only order the contract allows.
        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);
        yield_.investIdle(id);
    }

    function _finishRemaining(uint256 id) internal {
        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == Atelier.MilestoneStatus.NotStarted && ms[i].amount > 0) {
                _submit(id, i);
                vm.prank(client);
                sf.approveMilestone(id, i);
            }
        }
    }
}
