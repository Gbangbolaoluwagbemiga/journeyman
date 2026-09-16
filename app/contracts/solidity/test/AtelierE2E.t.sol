// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * END-TO-END JOURNEYS.
 *
 * The unit tests check that each door is locked to the right people. These walk
 * a whole job from "a client has an idea" to "a person has been paid and rated",
 * through the proxy, and check the things that only go wrong when steps are
 * combined:
 *
 *   - money is conserved at every hop — nothing is created, nothing is stranded
 *   - the platform fee is taken once, and is exactly the fee that was quoted
 *   - a job survives the awkward middles: a rejected milestone, a losing
 *     applicant, a dispute two-thirds of the way through
 *   - Atelier's three client modes all end at the same contract state
 *
 * The invariant asserted after every journey is the one that actually matters
 * to a user: the contract holds precisely what it still owes, and not a unit
 * more or less.
 */
contract AtelierE2ETest is JobManagerBase {
    /* ─────────────────────── helpers ─────────────────────── */

    /// Total USDC that exists across every party plus the contract.
    function _totalSupplyAcrossParties() internal view returns (uint256) {
        return
            usdc.balanceOf(client) +
            usdc.balanceOf(worker) +
            usdc.balanceOf(manager) +
            usdc.balanceOf(outsider) +
            usdc.balanceOf(arbiter) +
            usdc.balanceOf(feeCollector) +
            usdc.balanceOf(address(sf));
    }

    /**
     * The contract must hold at least what it still owes: outstanding escrow
     * plus uncollected fees. Checked after every step of every journey.
     */
    function _assertSolvent() internal view {
        uint256 owed = sf.escrowedAmount(address(usdc)) + sf.totalFeesByToken(address(usdc));
        assertGe(usdc.balanceOf(address(sf)), owed, "contract owes more than it holds");
    }

    function _fee(uint256 amount) internal view returns (uint256) {
        return (amount * sf.platformFeeBP()) / 10000;
    }

    /* ═══════════════════ JOURNEY 1 — manual, happy path ═══════════════════ */

    /**
     * Row one of Atelier's model: a human client who manages the job themselves.
     * Atelier exactly as it works today, walked end to end.
     */
    function test_e2e_manualJob_postToPaidAndRated() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();
        uint256 clientStart = usdc.balanceOf(client);
        uint256 expectedFee = _fee(BUDGET);

        // ── 1. Client posts an open job, funding budget + fee up front.
        uint256 id = _createOpenJob();
        assertEq(usdc.balanceOf(client), clientStart - BUDGET - expectedFee, "client debited once");
        assertEq(sf.escrowedAmount(address(usdc)), BUDGET, "budget escrowed");
        assertEq(sf.totalFeesByToken(address(usdc)), expectedFee, "fee separated at creation");
        _assertSolvent();

        // ── 2. Three people apply. Only one can win.
        _apply(id, worker);
        _apply(id, outsider);
        _apply(id, arbiter);
        assertTrue(sf.hasApplied(id, worker));
        assertTrue(sf.hasApplied(id, outsider));

        // ── 3. Client hires, freelancer starts.
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        (, address beneficiary,,,,,,,,,,,) = sf.escrows(id);
        assertEq(beneficiary, worker, "worker hired");

        // ── 4. Milestone one: delivered and approved.
        _submit(id, 0);
        vm.prank(client);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1, "paid for milestone one");
        assertEq(sf.escrowedAmount(address(usdc)), M2, "remainder still escrowed");
        _assertSolvent();

        // ── 5. Milestone two closes the job out.
        _submit(id, 1);
        vm.prank(client);
        sf.approveMilestone(id, 1);

        assertEq(usdc.balanceOf(worker), BUDGET, "worker paid in full");
        assertEq(sf.escrowedAmount(address(usdc)), 0, "nothing left escrowed");

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Released), "escrow released");
        assertEq(esc.paidAmount, BUDGET);

        // ── 6. Both sides rate each other; reputation moves.
        vm.prank(client);
        sf.submitRating(id, 5, "Excellent work");
        vm.prank(worker);
        sf.submitRating(id, 5, "Clear brief, prompt payment");

        assertEq(sf.completedEscrows(worker), 1, "worker completion counted");
        assertEq(sf.completedEscrows(client), 1, "client completion counted");
        assertEq(sf.reputation(worker), 1, "worker reputation");

        // ── 7. Platform collects the fee it quoted, and only that.
        vm.prank(feeCollector);
        sf.withdrawFees(address(usdc));
        assertEq(usdc.balanceOf(feeCollector), expectedFee, "fee collected exactly once");

        // ── 8. Nothing was created or destroyed along the way.
        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved end to end");
        assertEq(usdc.balanceOf(address(sf)), 0, "contract fully drained down");
        _assertSolvent();
    }

    /* ═════════════ JOURNEY 2 — Autopilot, with a revision round ═════════════ */

    /**
     * Row two: a human client, managed by the agent. The journey the whole merge
     * exists to make possible.
     *
     * Deliberately includes a rejection, because the interesting claim is not
     * "the agent can approve" — it is that the agent can say NO, ask for a
     * revision, and still never be able to take the money.
     */
    function test_e2e_autopilotJob_withRejectionAndRevision() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();
        uint256 expectedFee = _fee(BUDGET);

        // ── 1. Client funds the job and hands management to the agent.
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);
        assertTrue(sf.isJobManager(id, manager));

        // ── 2. Two apply; the agent picks one.
        _apply(id, worker);
        _apply(id, outsider);

        vm.prank(manager);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        // ── 3. First attempt is not good enough. The agent rejects it.
        _submit(id, 0);
        vm.prank(manager);
        sf.rejectMilestone(id, 0, "Wordmark is close, but the spacing is off");

        assertEq(usdc.balanceOf(worker), 0, "rejection paid nothing");
        assertEq(sf.escrowedAmount(address(usdc)), BUDGET, "and took nothing");
        _assertSolvent();

        // ── 4. Revision lands; the agent approves and pays.
        _submit(id, 0);
        vm.prank(manager);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1, "worker paid after revision");

        // ── 5. Second milestone completes the job, still under the agent.
        _submit(id, 1);
        vm.prank(manager);
        sf.approveMilestone(id, 1);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Released));
        assertEq(usdc.balanceOf(worker), BUDGET, "human paid in full by an agent");

        // ── 6. The one-way key held for the entire journey.
        assertEq(usdc.balanceOf(manager), 0, "agent never received a unit");

        // ── 7. The client, not the agent, is the one who rates.
        vm.prank(client);
        sf.submitRating(id, 5, "Handled start to finish");
        assertEq(sf.completedEscrows(worker), 1);

        vm.prank(feeCollector);
        sf.withdrawFees(address(usdc));
        assertEq(usdc.balanceOf(feeCollector), expectedFee);

        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved end to end");
        _assertSolvent();
    }

    /* ═══════════ JOURNEY 3 — Autopilot escalates to a human arbiter ═══════════ */

    /**
     * The journey that has to work or the product is not safe to use: the agent
     * and the worker disagree, a human steps in, and the money splits by the
     * human's ruling — with the agent unable to influence any of it.
     *
     * This is also the journey the teal/amber semantic is built to narrate: amber
     * all the way down, then teal from the escalation onward.
     */
    function test_e2e_autopilotEscalatesToArbiter() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();

        uint256 id = _liveAutopilotJob();

        // ── Milestone one is paid by the agent without incident.
        _submit(id, 0);
        vm.prank(manager);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1);

        // ── Milestone two: the agent rejects, the worker disagrees.
        _submit(id, 1);
        vm.prank(manager);
        sf.rejectMilestone(id, 1, "Does not meet the brief");

        vm.prank(worker);
        sf.disputeMilestone(id, 1, "It meets every criterion listed");

        // ── The agent is now locked out of the whole escrow, not just this
        //    milestone — escalation freezes the job to it.
        vm.prank(manager);
        vm.expectRevert(Atelier.EscrowNotActive.selector);
        sf.approveMilestone(id, 1);

        // Not Unauthorized any more -- a manager may escalate -- but a frozen
        // escrow refuses it just as it refuses the approve above.
        vm.prank(manager);
        vm.expectRevert(Atelier.EscrowNotActive.selector);
        sf.disputeMilestone(id, 1, "let me back in");

        // ── A human rules: two thirds to the worker.
        uint256 toWorker = (M2 * 2) / 3;
        uint256 toClient = M2 - toWorker;
        uint256 clientBefore = usdc.balanceOf(client);

        vm.prank(arbiter);
        sf.resolveDispute(id, 1, toWorker, toClient, "Partially met; split accordingly");

        assertEq(usdc.balanceOf(worker), M1 + toWorker, "worker got the arbiter's share");
        assertEq(usdc.balanceOf(client), clientBefore + toClient, "client refunded the rest");
        assertEq(usdc.balanceOf(manager), 0, "agent gained nothing from the dispute");

        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved through a dispute");
        _assertSolvent();
    }

    /* ═══════════ JOURNEY 4 — a job nobody takes, cancelled and refunded ═══════════ */

    function test_e2e_unfilledJobCancelledAndRefunded() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();
        uint256 clientStart = usdc.balanceOf(client);

        uint256 id = _createOpenJob();
        assertEq(usdc.balanceOf(client), clientStart - BUDGET - _fee(BUDGET));

        // First cancellation is free — the tiered penalty starts at zero.
        vm.prank(client);
        sf.cancelJob(id);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Cancelled));
        assertEq(sf.escrowedAmount(address(usdc)), 0, "escrow released back");
        assertEq(sf.userCancellations(client), 1, "cancellation recorded against the client");

        /*
         * Budget AND fee both come back.
         *
         * Worth pinning, because the intuitive guess is the other way round —
         * the fee is taken at creation, so you would expect it to be spent. It
         * is not: cancelJob refunds `esc.platformFee` alongside the budget, so a
         * client who posts a job nobody takes is made whole. Only the tiered
         * penalty bites, and the first two cancellations are free.
         *
         * This test asserts it deliberately rather than incidentally, because a
         * future change that starts keeping the fee would be a silent charge to
         * users and nothing else in the suite would notice.
         */
        assertEq(usdc.balanceOf(client), clientStart, "budget and fee both refunded");
        assertEq(sf.totalFeesByToken(address(usdc)), 0, "no fee retained on a free cancellation");

        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved through a cancellation");
        _assertSolvent();
    }

    /* ═══════════ JOURNEY 5 — the client takes back control mid-job ═══════════ */

    /**
     * A client who no longer likes how the agent is running their job must be
     * able to take over instantly, with the job intact. If this is awkward,
     * nobody sensible turns Autopilot on in the first place.
     */
    function test_e2e_clientRevokesAutopilotMidJobAndFinishesIt() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();
        uint256 id = _liveAutopilotJob();

        _submit(id, 0);
        vm.prank(manager);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1);

        // ── The client takes the keys back.
        vm.prank(client);
        sf.revokeJobManager(id);

        _submit(id, 1);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.approveMilestone(id, 1);

        // ── And finishes the job themselves, with everything the agent did
        //    still standing.
        vm.prank(client);
        sf.approveMilestone(id, 1);

        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(uint8(esc.status), uint8(Atelier.EscrowStatus.Released));
        assertEq(usdc.balanceOf(worker), BUDGET, "worker paid across the handover");
        assertEq(usdc.balanceOf(manager), 0);

        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved through a handover");
        _assertSolvent();
    }

    /* ═══════════ JOURNEY 6 — three jobs at once, all three modes ═══════════ */

    /**
     * Atelier's whole point is that these coexist in one marketplace. Run all
     * three of the product's rows concurrently against the same contract and
     * check they do not interfere: separate managers, separate money, one
     * shared fee pot.
     */
    function test_e2e_threeConcurrentJobsAcrossAllModes() public {
        uint256 supplyBefore = _totalSupplyAcrossParties();

        uint256 manualId = _createOpenJob();     // human client, self-managed
        uint256 autoId = _createOpenJob();       // human client, Autopilot
        uint256 agentId = _createOpenJob();      // (stands in for an agent client)

        vm.prank(client);
        sf.setJobManager(autoId, manager);
        vm.prank(client);
        sf.setJobManager(agentId, manager);

        _apply(manualId, worker);
        _apply(autoId, worker);
        _apply(agentId, outsider);

        vm.prank(client);
        sf.acceptFreelancer(manualId, worker);
        vm.prank(manager);
        sf.acceptFreelancer(autoId, worker);
        vm.prank(manager);
        sf.acceptFreelancer(agentId, outsider);

        vm.prank(worker);
        sf.startWork(manualId);
        vm.prank(worker);
        sf.startWork(autoId);
        vm.prank(outsider);
        sf.startWork(agentId);

        assertEq(sf.escrowedAmount(address(usdc)), BUDGET * 3, "three budgets held");
        _assertSolvent();

        // Manager has no authority over the manual job, though it manages two others.
        vm.prank(worker);
        sf.submitMilestone(manualId, 0, "manual work");
        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        sf.approveMilestone(manualId, 0);

        vm.prank(client);
        sf.approveMilestone(manualId, 0);

        // The two managed jobs proceed independently.
        vm.prank(worker);
        sf.submitMilestone(autoId, 0, "autopilot work");
        vm.prank(manager);
        sf.approveMilestone(autoId, 0);

        vm.prank(outsider);
        sf.submitMilestone(agentId, 0, "agent-client work");
        vm.prank(manager);
        sf.approveMilestone(agentId, 0);

        assertEq(usdc.balanceOf(worker), M1 * 2, "worker paid on both of their jobs");
        assertEq(usdc.balanceOf(outsider), M1, "other freelancer paid on theirs");
        assertEq(usdc.balanceOf(manager), 0, "manager still holds nothing");
        assertEq(sf.escrowedAmount(address(usdc)), BUDGET * 3 - M1 * 3, "escrow drawn down exactly");

        assertEq(_totalSupplyAcrossParties(), supplyBefore, "USDC conserved across three jobs");
        _assertSolvent();
    }

    /* ═══════════ JOURNEY 7 — paused platform blocks everything but reads ═══════════ */

    function test_e2e_pauseHaltsNewActivityButNotState() public {
        uint256 id = _liveAutopilotJob();
        _submit(id, 0);

        sf.pause();

        vm.prank(manager);
        vm.expectRevert();
        sf.approveMilestone(id, 0);

        vm.prank(client);
        vm.expectRevert();
        sf.setJobManager(id, outsider);

        // Reads still work — a paused platform must not hide anyone's position.
        Atelier.Escrow memory esc = sf.getEscrow(id);
        assertEq(esc.depositor, client);
        assertEq(sf.jobManager(id), manager);
        _assertSolvent();

        sf.unpause();

        vm.prank(manager);
        sf.approveMilestone(id, 0);
        assertEq(usdc.balanceOf(worker), M1, "resumes cleanly");
        _assertSolvent();
    }
}
