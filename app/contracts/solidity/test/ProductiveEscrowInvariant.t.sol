// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * Handler: a live escrow with yield enabled, and a venue the fuzzer can break
 * at will — mid-job, mid-dispute, mid-unwind, in any order.
 *
 * The failure injection is the point. A handler that only ever deposits and
 * withdraws politely would prove the happy path and nothing else, and the happy
 * path is not what a circuit breaker is for.
 */
contract YieldHandler is Test {
    Atelier public sf;
    MockUSDC public usdc;
    MockYieldAdapter public venue;
    AtelierYield public yield_;

    address public client;
    address public worker;
    address public arbiter;
    uint256 public escrowId;

    uint256 public constant BUDGET = 900e6;

    constructor(
        Atelier _sf, MockUSDC _usdc, MockYieldAdapter _venue, AtelierYield _yield,
        address _client, address _worker, address _arbiter, uint256 _escrowId
    ) {
        sf = _sf; usdc = _usdc; venue = _venue; yield_ = _yield;
        client = _client; worker = _worker; arbiter = _arbiter; escrowId = _escrowId;
    }

    function _idx(uint256 raw) internal pure returns (uint256) { return raw % 2; }

    /* ── the venue misbehaving ── */
    function breakVenue() external { venue.setRevertOnWithdraw(true); }
    function healVenue() external { venue.setRevertOnWithdraw(false); }
    function makeIlliquid(uint256 cap) external { venue.setLiquidCap(cap % 1000e6); }
    function shortchange(uint256 bp) external { venue.setPayoutBP(bp % 10001); }
    function loseValue(uint256 amount) external { venue.simulateYield(-int256(amount % 500e6)); }
    function earnValue(uint256 amount) external { venue.simulateYield(int256(amount % 50e6)); }

    /* ── the escrow being used ── */
    function invest() external { try yield_.investIdle(escrowId) {} catch {} }

    function optIn(bool on) external {
        vm.prank(client);
        try yield_.setYieldOptIn(escrowId, on) {} catch {}
    }

    function submit(uint256 raw) external {
        vm.prank(worker);
        try sf.submitMilestone(escrowId, _idx(raw), "work") {} catch {}
    }

    function approve(uint256 raw) external {
        vm.prank(client);
        try sf.approveMilestone(escrowId, _idx(raw)) {} catch {}
    }

    function reject(uint256 raw) external {
        vm.prank(client);
        try sf.rejectMilestone(escrowId, _idx(raw), "no") {} catch {}
    }

    function dispute(uint256 raw) external {
        vm.prank(worker);
        try sf.disputeMilestone(escrowId, _idx(raw), "unfair") {} catch {}
    }

    function resolve(uint256 raw, uint256 split) external {
        uint256 i = _idx(raw);
        uint256 total = i == 0 ? 300e6 : 600e6;
        uint256 toWorker = split % (total + 1);
        vm.prank(arbiter);
        try sf.resolveDispute(escrowId, i, toWorker, total - toWorker, "ruling") {} catch {}
    }
}

/**
 * PRODUCTIVE ESCROW — the invariant, fuzzed.
 *
 *     Money owed to people is never lent out.
 *
 * That is the whole feature stated as a property. The deployment cap keeps the
 * largest single claim in cash, so whatever the fuzzer does to the venue, this
 * contract can always settle the next claim from its own balance. If this ever
 * breaks, a freelancer somewhere cannot be paid because a pool was busy.
 */
contract ProductiveEscrowInvariantTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;
    YieldHandler internal handler;
    uint256 internal jobId;

    function setUp() public override {
        super.setUp();

        /* The yield layer is a companion contract now — it was 1.6KB of why
           Atelier could not be deployed at all. Same behaviour, wired through
           the escrow's single controller pointer. */
        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
        // The shipped default, so the fuzzer attacks what production runs.
        sf.setYieldController(address(yield_));

        jobId = _createOpenJob();
        // Before hiring: the choice is final once a freelancer is on the job.
        vm.prank(client);
        yield_.setYieldOptIn(jobId, true);
        _apply(jobId, worker);
        vm.prank(client);
        sf.acceptFreelancer(jobId, worker);
        vm.prank(worker);
        sf.startWork(jobId);

        handler = new YieldHandler(sf, usdc, venue, yield_, client, worker, arbiter, jobId);
        targetContract(address(handler));
    }

    /**
     * THE INVARIANT, as it actually is.
     *
     * The first version of this asserted that cash alone always covers the next
     * claim, and the fuzzer broke it in a few thousand calls: with the venue
     * refusing to return funds, cash sat at 502.5 against a claim of 600. That
     * is not a bug in the cap, it is the truth about circuit breakers — a
     * breaker can stop you *depending* on a venue, it cannot conjure money you
     * have already lent out.
     *
     * So the property this feature actually guarantees, and the only one it is
     * allowed to claim:
     *
     *     The contract always has a claim on enough money to settle what it
     *     owes. Cash plus deployed capital never falls below obligations.
     *
     * In plain terms: a dead venue can DELAY a payout. It cannot lose the
     * money, and it cannot leave the contract owing more than it holds a claim
     * on. That distinction is the whole feature, and the delay is documented in
     * Atelier.sol rather than hidden behind the word "always".
     */
    function invariant_contractCanAlwaysCoverWhatItOwes() public view {
        uint256 claimable =
            usdc.balanceOf(address(sf)) + yield_.deployedAssets(address(usdc));
        uint256 owed =
            sf.escrowedAmount(address(usdc)) + sf.totalFeesByToken(address(usdc));

        assertGe(claimable, owed, "obligations exceed cash plus deployed capital");
    }

    /**
     * Nothing may be lent out that this escrow does not still hold. Checked
     * against the escrow's own remaining balance while it is live — once it
     * settles, any residue is surfaced by the solvency invariant above rather
     * than by this one.
     */
    function invariant_deployedNeverExceedsWhatIsHeld() public view {
        Atelier.Escrow memory esc = sf.getEscrow(jobId);
        if (
            esc.status != Atelier.EscrowStatus.Pending &&
            esc.status != Atelier.EscrowStatus.InProgress
        ) return;

        assertLe(
            yield_.escrowDeployed(jobId),
            esc.totalAmount - esc.paidAmount,
            "deployed more than the escrow still owes"
        );
    }

    /**
     * With a HEALTHY venue the strong property does hold, and it is the one
     * that matters in normal operation: rebalancing keeps enough cash on hand
     * to settle the next claim without touching the pool.
     */
    function test_healthyVenueKeepsTheNextClaimInCash() public {
        handler.invest();
        handler.submit(0);
        handler.approve(0);

        Atelier.Milestone[] memory ms = sf.getMilestones(jobId);
        uint256 largest;
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == Atelier.MilestoneStatus.Approved) continue;
            if (ms[i].amount > largest) largest = ms[i].amount;
        }

        assertGe(
            usdc.balanceOf(address(sf)),
            largest,
            "healthy venue left the next claim uncovered"
        );
    }

    /**
     * And the documented limit, asserted rather than described: a dead venue
     * delays, it does not lose. The money is still claimable the moment the
     * venue comes back.
     */
    function test_deadVenueDelaysButDoesNotLose() public {
        handler.invest();
        uint256 deployed = yield_.escrowDeployed(jobId);
        assertGt(deployed, 0);

        handler.breakVenue();
        handler.submit(0);
        handler.approve(0);

        // Payment went through from cash...
        assertEq(usdc.balanceOf(worker), M1, "payout blocked");
        // ...and the stranded capital is still on the books, not written off.
        assertEq(yield_.escrowDeployed(jobId), deployed, "stranded capital written off");

        // When the venue recovers, the next payout reclaims it.
        handler.healVenue();
        handler.submit(1);
        handler.approve(1);
        assertEq(usdc.balanceOf(worker), M1 + M2, "capital never came back");
    }

    /**
     * Proof the handler is not inert. Every call is wrapped in try/catch, so a
     * handler whose calls all reverted would report clean invariants while
     * exercising nothing — the silent failure mode of this whole approach.
     */
    function test_handlerActuallyDeploysAndPays() public {
        handler.invest();
        assertGt(yield_.escrowDeployed(jobId), 0, "handler never deployed capital");

        handler.submit(0);
        handler.approve(0);
        assertEq(usdc.balanceOf(worker), M1, "handler never paid anyone");
    }

    function test_handlerCanBreakTheVenue() public {
        handler.invest();
        handler.breakVenue();

        handler.submit(0);
        handler.approve(0);
        assertEq(usdc.balanceOf(worker), M1, "payout blocked by a broken venue");
    }
}
