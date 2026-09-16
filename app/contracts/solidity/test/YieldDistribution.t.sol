// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * WHERE THE MONEY EARNED BY IDLE ESCROW ACTUALLY GOES.
 *
 * A freelance platform normally funds itself by taxing the freelancer. This one
 * funds itself from capital that was doing nothing — escrow sits still between
 * funding and approval, often for weeks — and the waterfall under test is what
 * turns that into a fee nobody pays.
 *
 *   client's fee first → then the freelancer's share → then the platform
 *   unless it went to arbitration, in which case the platform takes it all
 *
 * The first rule is the one that makes the feature exist at all. Opting in is
 * the client's call and nobody else's, so a split that gives the client nothing
 * is a split that never gets switched on.
 */
contract YieldDistributionTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();

        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));

        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    /// A funded job with a freelancer hired, opted in, capital deployed.
    function _earningJob() internal returns (uint256 id) {
        id = _createOpenJob();

        // Before anyone is hired: after that it is a term the freelancer took
        // the job on, and the contract refuses to let it change.
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        _apply(id, worker);

        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(worker);
        sf.startWork(id);

        yield_.investIdle(id);
    }

    /// Push the venue into profit, then finish the job so the position unwinds.
    function _earn(uint256 amount) internal {
        venue.simulateYield(int256(amount));
        deal(address(usdc), address(venue), usdc.balanceOf(address(venue)) + amount);
    }

    /* ─────────── the waterfall ─────────── */

    function test_theClientsFeeIsCoveredFirst() public {
        uint256 id = _earningJob();
        _earn(10e6);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0); // unwinds, banking the earnings

        uint256 fee = sf.getEscrow(id).platformFee;
        _finish(id);

        // After the job is done, so milestone payouts are not mistaken for yield.
        uint256 before = usdc.balanceOf(client);
        yield_.distributeYield(id);

        uint256 refunded = usdc.balanceOf(client) - before;
        assertGt(refunded, 0, "the client got nothing, so nobody would opt in");
        assertLe(refunded, fee, "refunded more than the fee that was charged");
    }

    function test_theFreelancerGetsTheLargerShareOfWhatIsLeft() public {
        uint256 id = _earningJob();
        _earn(50e6); // comfortably more than the fee

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);

        _finish(id);

        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 platformBefore = usdc.balanceOf(feeCollector);
        yield_.distributeYield(id);

        uint256 toWorker = usdc.balanceOf(worker) - workerBefore;
        uint256 toPlatform = usdc.balanceOf(feeCollector) - platformBefore;

        assertGt(toWorker, 0, "the freelancer's locked money earned them nothing");
        assertGt(toWorker, toPlatform, "the freelancer should take the larger share");
    }

    /// Nothing is invented: payouts never exceed what was actually earned.
    function test_neverPaysOutMoreThanWasEarned() public {
        uint256 id = _earningJob();
        _earn(20e6);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);

        _finish(id);

        uint256 banked = yield_.escrowYield(id);
        uint256 before = usdc.balanceOf(client) + usdc.balanceOf(worker) + usdc.balanceOf(feeCollector);
        yield_.distributeYield(id);

        uint256 paid = usdc.balanceOf(client) + usdc.balanceOf(worker) + usdc.balanceOf(feeCollector) - before;
        assertEq(paid, banked, "distributed something other than what was banked");
    }

    /* ─────────── arbitration takes it all ─────────── */

    function test_aDisputedJobSendsEveryPennyToThePlatform() public {
        uint256 id = _earningJob();
        _earn(40e6);

        _submit(id, 0);
        vm.prank(worker);
        sf.disputeMilestone(id, 0, "It meets the brief");

        vm.prank(arbiter);
        sf.resolveDispute(id, 0, M1 / 2, M1 - M1 / 2, "Half each");

        _finish(id);

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 platformBefore = usdc.balanceOf(feeCollector);
        yield_.distributeYield(id);

        assertEq(usdc.balanceOf(client), clientBefore, "client was paid on a disputed job");
        assertEq(usdc.balanceOf(worker), workerBefore, "freelancer was paid on a disputed job");
        assertGt(usdc.balanceOf(feeCollector), platformBefore, "platform got nothing");
    }

    /* ─────────── the edges ─────────── */

    function test_settlesOnlyOnce() public {
        uint256 id = _earningJob();
        _earn(20e6);
        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);
        _finish(id);

        yield_.distributeYield(id);
        vm.expectRevert(AtelierYield.AlreadySettled.selector);
        yield_.distributeYield(id);
    }

    function test_refusesWhileTheJobCouldStillMove() public {
        uint256 id = _earningJob();
        _earn(20e6);

        // Still in progress: more of the position may yet unwind, and settling
        // now would pay out a smaller number than the job actually earns.
        vm.expectRevert(AtelierYield.JobNotFinished.selector);
        yield_.distributeYield(id);
    }

    function test_aJobThatEarnedNothingSettlesQuietly() public {
        uint256 id = _earningJob();
        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);
        _finish(id);

        uint256 before = usdc.balanceOf(feeCollector);
        yield_.distributeYield(id); // must not revert
        assertEq(usdc.balanceOf(feeCollector), before, "paid out of thin air");
    }

    /// Anyone may trigger it — the people owed should not depend on us remembering.
    function test_anybodyCanTriggerThePayout() public {
        uint256 id = _earningJob();
        _earn(20e6);
        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);
        _finish(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(outsider);
        yield_.distributeYield(id);
        assertGt(usdc.balanceOf(client), before, "a stranger could not trigger it");
    }

    /// Drive the escrow to a terminal state so distribution is allowed.
    function _finish(uint256 id) internal {
        Atelier.Escrow memory esc = sf.getEscrow(id);
        if (esc.status == Atelier.EscrowStatus.Released) return;

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
