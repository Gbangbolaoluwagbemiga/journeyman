// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";
import "./MockYieldAdapter.t.sol";
import "../src/yield/AtelierYield.sol";

/**
 * THE YIELD SHARE IS A TERM OF THE JOB, NOT A SETTING ON IT.
 *
 * A freelancer reads "this escrow earns while you work, and 60% of what it
 * earns is yours" on the board, and applies partly because of it. If the client
 * could switch that off after hiring, they would be changing the deal after the
 * other side accepted it — and the freelancer would have no recourse and, more
 * likely, no idea it had happened.
 *
 * The first version of this feature was a toggle on the job page, live for the
 * whole life of the escrow. That is the bug these tests exist to keep fixed.
 *
 * The window is "before anybody is hired" rather than "in the creating
 * transaction" for two practical reasons: a failed attempt has to be
 * retryable, and a client who thinks it over for a day has promised nobody
 * anything yet.
 */
contract YieldCommitmentTest is JobManagerBase {
    AtelierYield internal yield_;
    MockYieldAdapter internal venue;

    function setUp() public override {
        super.setUp();
        yield_ = new AtelierYield(address(sf));
        venue = new MockYieldAdapter(address(usdc), address(yield_));
        sf.setYieldController(address(yield_));
        yield_.setYieldAdapter(address(usdc), address(venue));
    }

    /* ─────────── answering it ─────────── */

    function test_theQuestionStartsUnanswered() public {
        uint256 id = _createOpenJob();
        assertFalse(yield_.yieldChoiceMade(id), "an unposted answer counts as answered");
        assertFalse(yield_.yieldOptIn(id), "defaulted to on");
    }

    function test_theClientCanSayYesWhilePostingTheJob() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        assertTrue(yield_.yieldOptIn(id));
        assertTrue(yield_.yieldChoiceMade(id));
    }

    /**
     * "No" has to be recorded as an answer, not left looking like silence.
     * Otherwise opting out and never being asked are the same state, and the
     * lock below cannot tell a first answer from a second one.
     */
    function test_sayingNoIsAnAnswerAndNotAnAbsence() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, false);

        assertFalse(yield_.yieldOptIn(id));
        assertTrue(yield_.yieldChoiceMade(id), "a no did not count as answering");
    }

    /* ─────────── and never again ─────────── */

    function test_theClientCannotChangeTheirMind() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        vm.prank(client);
        vm.expectRevert(AtelierYield.ChoiceAlreadyMade.selector);
        yield_.setYieldOptIn(id, false);

        assertTrue(yield_.yieldOptIn(id), "the term changed after it was set");
    }

    function test_theClientCannotTurnItOnLaterEither() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        yield_.setYieldOptIn(id, false);

        vm.prank(client);
        vm.expectRevert(AtelierYield.ChoiceAlreadyMade.selector);
        yield_.setYieldOptIn(id, true);
    }

    /**
     * The one that matters: the freelancer has accepted the job. Even a client
     * who never answered the question cannot answer it now, because the answer
     * is part of what was accepted.
     */
    function test_theWindowClosesWhenTheFreelancerStartsWork() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(AtelierYield.TooLateToChoose.selector);
        yield_.setYieldOptIn(id, true);
    }

    /**
     * A DIRECTLY ASSIGNED JOB MUST BE ABLE TO ANSWER AT ALL.
     *
     * An escrow created with a named freelancer has a beneficiary from its
     * first block. The original rule closed the window on "beneficiary is set",
     * which meant this entire kind of job could never opt in — and no test
     * caught it, because every yield fixture posted an open job.
     */
    function test_aDirectlyAssignedJobCanStillChoose() public {
        uint256 id = _createAssignedJob();

        vm.prank(client);
        yield_.setYieldOptIn(id, true);

        assertTrue(yield_.yieldOptIn(id), "a named-freelancer job could not opt in");
    }

    function test_aDirectlyAssignedJobLocksOnceWorkBegins() public {
        uint256 id = _createAssignedJob();
        vm.prank(worker);
        sf.startWork(id);

        vm.prank(client);
        vm.expectRevert(AtelierYield.TooLateToChoose.selector);
        yield_.setYieldOptIn(id, true);
    }

    /**
     * Adding the share after hiring but before work begins is allowed, because
     * it can only make the job better for the person who took it. Removing it
     * is what must never happen, and ChoiceAlreadyMade is what prevents that.
     */
    function test_aClientMayStillSayYesAfterHiringButBeforeWorkStarts() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);
        vm.prank(client);
        sf.acceptFreelancer(id, worker);

        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        assertTrue(yield_.yieldOptIn(id));
    }

    /// A job created with a freelancer already named on it.
    function _createAssignedJob() internal returns (uint256 id) {
        address[] memory arbiters = new address[](1);
        arbiters[0] = arbiter;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = M1;
        amounts[1] = M2;
        string[] memory descs = new string[](2);
        descs[0] = "First milestone";
        descs[1] = "Second milestone";

        vm.prank(client);
        id = sf.createEscrow(
            worker, address(usdc), BUDGET, 30, arbiters, 1, amounts, descs, "Logo", "A logo"
        );
    }

    function test_theWindowIsStillOpenWhileApplicationsAreComingIn() public {
        uint256 id = _createOpenJob();
        _apply(id, worker);

        // Nobody has been promised anything yet, so the client may still decide.
        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        assertTrue(yield_.yieldOptIn(id));
    }

    /* A first attempt that reverted must not lock the question forever. */
    function test_aFailedAttemptLeavesTheQuestionOpen() public {
        uint256 id = _createOpenJob();

        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        yield_.setYieldOptIn(id, true);

        assertFalse(yield_.yieldChoiceMade(id), "a rejected call consumed the choice");

        vm.prank(client);
        yield_.setYieldOptIn(id, true);
        assertTrue(yield_.yieldOptIn(id));
    }

    /* ─────────── whose choice it is ─────────── */

    function test_onlyTheDepositorMayAnswer() public {
        uint256 id = _createOpenJob();
        vm.prank(outsider);
        vm.expectRevert(Atelier.Unauthorized.selector);
        yield_.setYieldOptIn(id, true);
    }

    /**
     * Not even an Autopilot manager, which can hire, approve and reject.
     * Delegating the running of a job is not delegating what the client's own
     * capital does while it waits.
     */
    function test_notEvenAnAutopilotManagerMayAnswerForTheClient() public {
        uint256 id = _createOpenJob();
        vm.prank(client);
        sf.setJobManager(id, manager);

        vm.prank(manager);
        vm.expectRevert(Atelier.Unauthorized.selector);
        yield_.setYieldOptIn(id, true);
    }

    function test_theFreelancerCannotTurnItOnForThemselves() public {
        uint256 id = _createOpenJob();
        vm.prank(worker);
        vm.expectRevert(Atelier.Unauthorized.selector);
        yield_.setYieldOptIn(id, true);
    }
}
