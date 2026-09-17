// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/JourneymanYield.sol";

/**
 * DOES THE CONTROLLER STILL KNOW WHERE THE MONEY IS?
 *
 * The controller keeps two books: `deployedAssets`, per token, and
 * `escrowDeployed`, per escrow. Only one of them can be kept honest by
 * `ensureLiquid`, because the escrow calls that from _doTransfer and has no
 * escrow id to pass — so an unwind that covers a payment reduces the pooled
 * total and leaves every per-escrow figure untouched.
 *
 * Nothing is mispaid when that happens: the escrow pays out of its own balance
 * against its own per-escrow arithmetic, and this contract's books do not enter
 * into it. What breaks is the controller's belief about where the capital is,
 * and that belief decides two things — whether more can be deployed, and
 * whether the controller can ever be replaced, since the deploy script refuses
 * to swap one with capital still out.
 *
 * Found by running a real job against the live deployment rather than by any of
 * the 186 tests that existed, which is the argument for this file.
 */
contract YieldBookkeepingTest is JobManagerBase {
    JourneymanYield internal yield_;
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();
        yield_ = new JourneymanYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    function _earningJob() internal returns (uint256 id) {
        id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);
        yield_.investIdle(id);
    }

    /**
     * The shape that broke it: a final milestone larger than the cash left
     * after the first, so paying it MUST go through ensureLiquid.
     *
     * The fixture's 300/600 split does exactly that. 900 budget deploys 210 —
     * everything above the largest unpaid claim of 600 plus a 10% buffer — and
     * the 600 stage then needs more than the remaining cash.
     */
    function test_theBooksAgreeAfterAPaymentPulledCapitalBack() public {
        uint256 id = _earningJob();
        uint256 deployed = yield_.escrowDeployed(id);
        assertGt(deployed, 0, "nothing was deployed, so nothing is under test");

        /*
         * A VENUE THAT CANNOT QUITE RETURN ITS OWN PRINCIPAL.
         *
         * This is not failure injection for its own sake — it is what the real
         * adapter does. Minting a Uniswap v4 position rounds the liquidity
         * down, so 1,600,000 deposited is worth 1,599,999 the instant it lands,
         * and `withdraw` reverts rather than underpay. Asking for the book
         * value therefore failed on EVERY full unwind, measured on the live
         * pool. One unit is all it takes.
         */
        venue.setLiquidCap(deployed - 1);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0); // paid from cash

        _submit(id, 1);
        vm.prank(client);
        sf.approveMilestone(id, 1); // forces ensureLiquid, then rebalances

        assertEq(usdc.balanceOf(worker), BUDGET, "the freelancer was not paid in full");

        /*
         * The bug in one assertion. escrowDeployed stayed at its original
         * figure while the venue had been drained to cover the payment, so the
         * rebalance asked for money that was not there, the adapter reverted
         * rather than underpay — exactly as it promises — and the remainder sat
         * in the venue with the book permanently wrong.
         */
        /*
         * One unit, not 210,000,000. The position closed; what remains is the
         * rounding the venue could never return, and it stays on the books as
         * an honest "we cannot reach this" rather than being written off.
         */
        assertLe(yield_.escrowDeployed(id), 1, "the escrow's book still claims deployed capital");
        assertLe(yield_.deployedAssets(address(usdc)), 1, "capital stranded in the venue");
        assertLe(venue.totalAssets(), 1, "more than rounding dust was left behind");
    }

    /// The same, with the venue refusing to pay: the book must still come true.
    function test_aDeadVenueDoesNotLeaveTheBookLying() public {
        uint256 id = _earningJob();
        uint256 deployed = yield_.escrowDeployed(id);
        assertGt(deployed, 0, "nothing was deployed, so nothing is under test");

        /*
         * Break it BEFORE the first approval. Approving the 300 stage drops the
         * ceiling to zero — the remaining 600 is smaller than that claim plus
         * its buffer — so the rebalance that follows tries to close the whole
         * position, and with the venue refusing it closes none of it.
         */
        venue.setRevertOnWithdraw(true);

        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0); // paid from cash; the unwind after it fails

        // Nothing came back, so both books must still say the money is out
        // there. An honest "we cannot reach it" is the right answer; a zero
        // would be this contract forgetting capital that really does exist,
        // and the clamp added for the stale-book bug must not cause that.
        assertEq(yield_.escrowDeployed(id), deployed, "wrote off capital the venue still holds");
        assertEq(yield_.deployedAssets(address(usdc)), deployed, "pool book diverged from the escrow book");
        assertEq(venue.totalAssets(), deployed, "the venue's own figure disagrees with both");
    }

    /// Two escrows sharing one venue: one paying out must not strand the other.
    function test_oneEscrowPayingOutDoesNotStrandAnother() public {
        uint256 a = _earningJob();
        uint256 b = _earningJob();
        assertGt(yield_.escrowDeployed(a), 0);
        assertGt(yield_.escrowDeployed(b), 0);

        _submit(a, 0);
        vm.prank(client);
        sf.approveMilestone(a, 0);
        _submit(a, 1);
        vm.prank(client);
        sf.approveMilestone(a, 1);

        _submit(b, 0);
        vm.prank(client);
        sf.approveMilestone(b, 0);
        _submit(b, 1);
        vm.prank(client);
        sf.approveMilestone(b, 1);

        assertEq(yield_.deployedAssets(address(usdc)), 0, "capital stranded across two escrows");
        assertEq(yield_.escrowDeployed(a), 0, "escrow A's book still claims capital");
        assertEq(yield_.escrowDeployed(b), 0, "escrow B's book still claims capital");
        assertEq(usdc.balanceOf(worker), BUDGET * 2, "both freelancers were not paid in full");
    }
}
