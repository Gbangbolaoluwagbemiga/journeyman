// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * Handler: everything a manager can reach, exposed for the fuzzer to hammer in
 * whatever order it likes.
 *
 * Calls are wrapped in try/catch so a revert is a dead end rather than the end
 * of the run — the point is to let the fuzzer wander through thousands of
 * orderings looking for the one that leaks value, not to assert that any
 * particular call succeeds.
 *
 * The handler deliberately includes the calls a manager should NOT have
 * (dispute, cancel, extend, withdraw, self-appointment). If the guards were
 * ever loosened, the fuzzer would find the path and the invariant would break.
 * A handler that only offers the permitted calls proves nothing.
 */
contract ManagerHandler is Test {
    Atelier public sf;
    MockUSDC public usdc;

    address public client;
    address public manager;
    address public worker;
    address public arbiter;
    uint256 public escrowId;

    uint256 public managerCallsMade;

    constructor(
        Atelier _sf,
        MockUSDC _usdc,
        address _client,
        address _manager,
        address _worker,
        address _arbiter,
        uint256 _escrowId
    ) {
        sf = _sf;
        usdc = _usdc;
        client = _client;
        manager = _manager;
        worker = _worker;
        arbiter = _arbiter;
        escrowId = _escrowId;
    }

    function _idx(uint256 raw) internal pure returns (uint256) {
        return raw % 2;
    }

    /* ── What a manager is supposed to be able to do ── */

    function managerApprove(uint256 rawIndex) external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.approveMilestone(escrowId, _idx(rawIndex)) {} catch {}
    }

    function managerReject(uint256 rawIndex) external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.rejectMilestone(escrowId, _idx(rawIndex), "no") {} catch {}
    }

    /* ── What it must never manage to do ── */

    /// Any address the fuzzer likes, including the manager itself.
    function managerAccept(address candidate) external {
        managerCallsMade++;
        vm.prank(candidate);
        try sf.applyToJob(escrowId, "cv", 3) {} catch {}
        vm.prank(manager);
        try sf.acceptFreelancer(escrowId, candidate) {} catch {}
    }

    function managerTriesToSelfHire() external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.applyToJob(escrowId, "cv", 3) {} catch {}
        vm.prank(manager);
        try sf.acceptFreelancer(escrowId, manager) {} catch {}
    }

    function managerTriesToReappoint(address to) external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.setJobManager(escrowId, to) {} catch {}
    }

    function managerTriesToDispute() external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.disputeMilestone(escrowId, 0, "mine now") {} catch {}
    }

    function managerTriesToCancel() external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.cancelJob(escrowId) {} catch {}
    }

    function managerTriesToWithdraw(uint256 amount) external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.withdrawJobFunds(escrowId, amount % 1000e6, 0) {} catch {}
    }

    function managerTriesToExtend(uint256 daysToAdd) external {
        managerCallsMade++;
        vm.prank(manager);
        try sf.extendDeadline(escrowId, daysToAdd % 30) {} catch {}
    }

    /* ── Other parties, so the job can actually progress ── */

    function workerSubmits(uint256 rawIndex) external {
        vm.prank(worker);
        try sf.submitMilestone(escrowId, _idx(rawIndex), "work") {} catch {}
    }

    function workerStarts() external {
        vm.prank(worker);
        try sf.startWork(escrowId) {} catch {}
    }

    function workerDisputes(uint256 rawIndex) external {
        vm.prank(worker);
        try sf.disputeMilestone(escrowId, _idx(rawIndex), "unfair") {} catch {}
    }

    function arbiterResolves(uint256 rawIndex, uint256 split) external {
        uint256 i = _idx(rawIndex);
        uint256 total = i == 0 ? 300e6 : 600e6;
        uint256 toWorker = split % (total + 1);
        vm.prank(arbiter);
        try sf.resolveDispute(escrowId, i, toWorker, total - toWorker, "ruling") {} catch {}
    }

    function clientRevokesManager() external {
        vm.prank(client);
        try sf.revokeJobManager(escrowId) {} catch {}
    }

    function clientReappointsManager() external {
        vm.prank(client);
        try sf.setJobManager(escrowId, manager) {} catch {}
    }
}

/**
 * THE ONE-WAY KEY, as a fuzzed invariant.
 *
 *     No sequence of actions available to a manager can cause value to reach
 *     the manager.
 *
 * This is the property the entire Autopilot product rests on, and the one the
 * UI states to a client in plain words before they hand over a job. A unit test
 * shows it holds on the paths we thought of; this shows it holds on the ones we
 * did not.
 */
contract JobManagerInvariantTest is JobManagerBase {
    ManagerHandler internal handler;

    function setUp() public override {
        super.setUp();

        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        _apply(id, worker);
        vm.prank(manager);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        handler = new ManagerHandler(sf, usdc, client, manager, worker, arbiter, id);
        targetContract(address(handler));
    }

    /// The invariant itself.
    function invariant_managerNeverReceivesValue() public view {
        assertEq(
            usdc.balanceOf(manager),
            0,
            "manager received USDC - the one-way key is broken"
        );
    }

    /**
     * The manager must never end up as the party who gets paid, either — a
     * balance of zero would also be satisfied by a manager who is *about* to be
     * paid on the next approval.
     */
    function invariant_managerIsNeverTheBeneficiary() public view {
        // The generated getter omits the address[] arbiters field, so this
        // destructures 13 components rather than the struct's 14.
        (, address beneficiary,,,,,,,,,,,) = sf.escrows(handler.escrowId());
        assertTrue(beneficiary != manager, "manager became the beneficiary");
    }

    /**
     * PROOF THE INVARIANTS ARE NOT VACUOUS.
     *
     * Every handler call is wrapped in try/catch, so a handler whose calls all
     * reverted would report 128,000 calls, zero reverts, and three passing
     * invariants while testing nothing at all. That is the failure mode of this
     * whole approach, and it is silent.
     *
     * So: drive the handler by hand along the path that MUST move money, and
     * assert it moved. If this breaks, the invariants above stopped meaning
     * anything and the suite has to be believed less, not more.
     */
    function test_handlerActuallyMovesMoney() public {
        handler.workerSubmits(0);
        handler.managerApprove(0);

        assertEq(usdc.balanceOf(worker), M1, "handler never paid the worker");
        assertGt(handler.managerCallsMade(), 0, "handler never reached the manager");
    }

    /**
     * And the rejection path, which is the other half of what a manager does —
     * a handler that could only ever approve would leave the reject guard
     * unexercised by the fuzzer.
     */
    function test_handlerCanRejectWithoutPaying() public {
        handler.workerSubmits(0);
        handler.managerReject(0);
        assertEq(usdc.balanceOf(worker), 0, "rejection paid out");

        handler.workerSubmits(0);
        handler.managerApprove(0);
        assertEq(usdc.balanceOf(worker), M1, "resubmission could not be approved");
    }

    /**
     * The contract must never owe out more than it holds. If a manager could
     * conjure an approval that pays twice, this catches it even when the
     * manager itself gains nothing.
     */
    function invariant_contractStaysSolvent() public view {
        assertGe(
            usdc.balanceOf(address(sf)),
            sf.escrowedAmount(address(usdc)),
            "contract owes more than it holds"
        );
    }
}
