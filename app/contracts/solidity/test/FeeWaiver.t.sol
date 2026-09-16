// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * WHY A CLIENT WOULD EVER PUT THEIR ESCROW TO WORK.
 *
 * They would not have. The platform fee was charged either way and the yield
 * refunded it later, which sounds like a benefit and is not one: a job deploys
 * roughly 40% of its budget, so covering a 2.5% fee needs rate × days ≥ 22.8.
 * That is 228 days at 10% APY, and the budget cancels out of the inequality
 * entirely — a bigger job does not help. No freelance job is long enough, so
 * the client recovered a rounding error and had no reason to switch it on.
 *
 * So the platform gives up the fee outright instead, and takes 40% of what the
 * escrow earns plus a job that carries a share for whoever takes it. The client
 * sees the benefit where benefits have to be seen: in the number their wallet
 * asks them to approve.
 */
contract FeeWaiverTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;

    uint256 internal constant FEE = (BUDGET * 250) / 10000;

    function setUp() public override {
        super.setUp();
        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    /* ─────────── what it costs ─────────── */

    function test_anOrdinaryJobPaysTheFee() public {
        uint256 before = usdc.balanceOf(client);
        _createOpenJob();
        assertEq(before - usdc.balanceOf(client), BUDGET + FEE, "fee was not charged");
    }

    function test_ajobPostedToWorkPaysNoFeeAtAll() public {
        vm.prank(client);
        yield_.setWorkIntent(true);

        uint256 before = usdc.balanceOf(client);
        uint256 id = _createOpenJob();

        assertEq(before - usdc.balanceOf(client), BUDGET, "the client still paid a fee");
        assertEq(sf.getEscrow(id).platformFee, 0, "a fee was recorded on a waived job");
    }

    function test_theJobIsOptedInWithoutASecondSignature() public {
        vm.prank(client);
        yield_.setWorkIntent(true);
        uint256 id = _createOpenJob();

        assertTrue(yield_.yieldOptIn(id), "posted to work but not opted in");
        assertTrue(yield_.yieldChoiceMade(id), "the question was left open");
    }

    /* ─────────── the intent is for one job ─────────── */

    /* Otherwise a client who did it once would silently stop paying forever. */
    function test_theIntentIsConsumedByTheVeryNextJob() public {
        vm.prank(client);
        yield_.setWorkIntent(true);
        _createOpenJob();

        uint256 before = usdc.balanceOf(client);
        uint256 second = _createOpenJob();

        assertEq(before - usdc.balanceOf(client), BUDGET + FEE, "the second job was free too");
        assertFalse(yield_.yieldOptIn(second), "the second job opted itself in");
    }

    function test_aClientCanChangeTheirMindBeforePosting() public {
        vm.prank(client);
        yield_.setWorkIntent(true);
        vm.prank(client);
        yield_.setWorkIntent(false);

        uint256 before = usdc.balanceOf(client);
        _createOpenJob();
        assertEq(before - usdc.balanceOf(client), BUDGET + FEE);
    }

    /* One client's intent must not waive another client's fee. */
    function test_theIntentBelongsToTheClientWhoSetIt() public {
        vm.prank(outsider);
        yield_.setWorkIntent(true);

        uint256 before = usdc.balanceOf(client);
        _createOpenJob();
        assertEq(before - usdc.balanceOf(client), BUDGET + FEE, "someone else's intent was spent");
    }

    /* ─────────── nobody else may spend it ─────────── */

    function test_onlyTheEscrowCanClaimAnIntent() public {
        vm.prank(client);
        yield_.setWorkIntent(true);

        vm.prank(outsider);
        vm.expectRevert(AtelierYield.NotEscrow.selector);
        yield_.claimIntent(client, 1);
    }

    /* ─────────── and what it buys the other two ─────────── */

    /**
     * With no fee to refund, the whole of what the escrow earns goes to the
     * freelancer and the platform. That is the trade: a certain 2.5% given up
     * for 40% of an uncertain return.
     */
    function test_withNoFeeToRefundTheEarningsGoToTheWorkAndThePlatform() public {
        vm.prank(client);
        yield_.setWorkIntent(true);
        uint256 id = _createOpenJob();

        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);
        yield_.investIdle(id);

        venue.simulateYield(int256(uint256(50e6)));
        deal(address(usdc), address(venue), usdc.balanceOf(address(venue)) + 50e6);

        Atelier.Milestone[] memory ms = sf.getMilestones(id);
        for (uint256 i; i < ms.length; ++i) {
            _submit(id, i);
            vm.prank(client);
            sf.approveMilestone(id, i);
        }

        uint256 clientBefore = usdc.balanceOf(client);
        uint256 workerBefore = usdc.balanceOf(worker);
        uint256 platformBefore = usdc.balanceOf(feeCollector);
        yield_.distributeYield(id);

        assertEq(usdc.balanceOf(client), clientBefore, "refunded a fee that was never charged");
        assertGt(usdc.balanceOf(worker) - workerBefore, 0, "the freelancer earned nothing");
        assertGt(
            usdc.balanceOf(worker) - workerBefore,
            usdc.balanceOf(feeCollector) - platformBefore,
            "the platform took more than the freelancer"
        );
    }
}

/**
 * WHAT PAYING TO CANCEL IS FOR.
 *
 * The tier on a client's own cancellation count is gone. It read as part of the
 * same fee as the applicant charge and was not — the tier forgave the first two
 * cancellations and the applicant charge never did — and more to the point it
 * had nobody on the other end of it. Charging for a pattern rather than for
 * harm is a fine, not a fee.
 *
 * Giving it up bought the bytes to waive the platform fee, which is a benefit
 * somebody actually receives.
 */
contract CancellationFeeTest is JobManagerBase {
    function test_pullingDownAJobNobodyAppliedToIsFree() public {
        uint256 id = _createOpenJob();
        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);
        assertEq(usdc.balanceOf(client) - before, BUDGET + (BUDGET * 250) / 10000);
    }

    function test_pullingDownAJobSomebodyAppliedToCosts5Percent() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.cancelJob(id);
        assertEq(
            usdc.balanceOf(client) - before,
            BUDGET + (BUDGET * 250) / 10000 - (BUDGET * 5) / 100
        );
    }

    /* The charge is about the applicants, so a repeat canceller with none pays
       nothing — where the old tier would have started charging at the third. */
    function test_repeatedCancellationsWithNoApplicantsStayFree() public {
        for (uint256 i; i < 4; ++i) {
            uint256 id = _createOpenJob();
            uint256 before = usdc.balanceOf(client);
            vm.prank(client);
            sf.cancelJob(id);
            assertEq(
                usdc.balanceOf(client) - before,
                BUDGET + (BUDGET * 250) / 10000,
                "charged for a pattern rather than for harm"
            );
        }
    }
}
