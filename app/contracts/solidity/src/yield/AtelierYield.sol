// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IAtelierYield.sol";
import "./IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/** The slice of Atelier this controller needs to reason about safety. */
interface IAtelierEscrows {
    enum EscrowStatus { Pending, InProgress, Released, Refunded, Disputed, Expired, Cancelled }
    enum MilestoneStatus { NotStarted, Submitted, Approved, Rejected, Disputed, ProposalPending }

    struct Milestone {
        uint256 amount;
        string description;
        string requirements;
        MilestoneStatus status;
        uint256 submittedAt;
        uint256 approvedAt;
        uint256 disputedAt;
        address disputedBy;
        string disputeReason;
        string rejectionReason;
        uint256 resolvedAt;
        address resolvedBy;
        uint256 proposedAmount;
        string proposedDescription;
        uint256 resolutionFreelancerAmount;
        uint256 resolutionClientAmount;
        string resolutionReason;
    }

    struct Escrow {
        address depositor;
        address beneficiary;
        address token;
        uint256 totalAmount;
        uint256 paidAmount;
        uint256 deadline;
        EscrowStatus status;
        bool workStarted;
        uint256 platformFee;
        address[] arbiters;
        uint256 requiredConfirmations;
        bool isOpenJob;
        string projectTitle;
        string projectDescription;
    }

    function getEscrow(uint256 escrowId) external view returns (Escrow memory);
    function getMilestones(uint256 escrowId) external view returns (Milestone[] memory);
    function feeCollector() external view returns (address);
}

/**
 * @title AtelierYield
 * @notice Productive escrow: idle capital earns, and never at the cost of a payout.
 *
 * WHY THIS IS A SEPARATE CONTRACT
 *
 * It used to live inside Atelier. That pushed the escrow to 26.2KB against
 * EIP-170's 24,576-byte limit, which meant the feature could not be deployed at
 * all — and trimming a working escrow to make room would have made the contract
 * smaller and worse. Two attempts at shaving bytes are recorded in Atelier.sol
 * so nobody repeats them: dropping optimizer_runs saved 292 bytes, and moving
 * the cancellation-penalty maths to a library made it BIGGER.
 *
 * Splitting it is the right answer anyway, not just the one that fits. The
 * escrow's job is holding money safely; deciding where idle capital earns is a
 * different job with a different risk profile, and it can now be replaced,
 * paused or disconnected without touching the contract that custodies funds.
 *
 * THE INVARIANT, unchanged by the move:
 *
 *     Cash plus deployed capital never falls below what is owed.
 *
 * A failing venue can DELAY a payout. It cannot lose the money, and it cannot
 * leave the escrow owing more than it holds a claim on.
 */
contract AtelierYield is IAtelierYield, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotEscrow();
    error BufferTooLow();
    error InvalidConfig();
    error AlreadySettled();
    error UnknownEscrow();
    error JobNotFinished();
    error Unauthorized();
    error ChoiceAlreadyMade();
    error TooLateToChoose();

    address public immutable escrow;

    mapping(address => IYieldAdapter) public yieldAdapter;
    /**
     * Fraction of an escrow's remainder never deployed, in basis points.
     *
     * Ten percent, on top of the largest unpaid milestone rather than instead
     * of it. The milestone reserve is what makes a payout instant — the next
     * claim, whatever its size, is always already in cash — and this is the
     * margin on top for everything that is not the next claim.
     *
     * It was twenty. Halving it puts more of a large escrow to work without
     * touching the guarantee: on a 10 USDC job split 4/3/3 the cash reserve
     * goes from 6 to 5, and the 4 that any single approval could ask for stays
     * where it is either way. The floor in setYieldBuffer is this number, so it
     * cannot be tuned lower without changing the code that says why.
     */
    uint256 public yieldBufferBP = 1000;
    mapping(uint256 => bool) public yieldOptIn;

    /**
     * Whether this escrow's yield question has been answered.
     *
     * Separate from `yieldOptIn` because "no" and "not yet asked" are different
     * states and a single bool cannot hold both — without this, opting out
     * would be indistinguishable from never having decided, and the lock below
     * could never tell a first answer from a second one.
     */
    mapping(uint256 => bool) public yieldChoiceMade;
    mapping(address => uint256) public deployedAssets;
    mapping(uint256 => uint256) public escrowDeployed;

    /**
     * Yield this escrow has actually earned, banked as its position unwound.
     *
     * It has to be credited on the way out rather than computed at the end: by
     * the time a job settles, onObligationChanged has already pulled its
     * principal back, so escrowDeployed is zero and there is nothing left to
     * take a share of. Whatever came back above the principal is the earnings,
     * and it is already sitting in this contract.
     */
    mapping(uint256 => uint256) public escrowYield;

    /** Paid out once, whatever else happens. */
    mapping(uint256 => bool) public yieldSettled;

    /**
     * The freelancer's share of what is left after the client's fee is covered.
     *
     * They are the party whose money sat locked while it earned, which is the
     * whole reason there is anything to split — and a marketplace's hard side
     * is freelancers, not clients.
     */
    uint256 public freelancerShareBP = 6000;

    event YieldAdapterSet(address indexed token, address indexed adapter);
    event YieldOptInChanged(uint256 indexed escrowId, bool optedIn);
    event WorkIntentSet(address indexed client, bool on);
    event FreelancerShareUpdated(uint256 bp);
    event YieldAccrued(uint256 indexed escrowId, uint256 amount);
    event YieldDistributed(
        uint256 indexed escrowId,
        uint256 feeWaived,
        uint256 toFreelancer,
        uint256 toPlatform
    );
    event YieldDeployed(address indexed token, uint256 amount);
    event YieldUnwound(address indexed token, uint256 requested, uint256 recovered);
    /** The venue could not return funds on demand. Surfaced, never swallowed. */
    event YieldCircuitBreakerTripped(address indexed token, uint256 shortfall);

    modifier onlyEscrow() {
        if (msg.sender != escrow) revert NotEscrow();
        _;
    }

    constructor(address _escrow) Ownable(msg.sender) {
        if (_escrow == address(0)) revert InvalidConfig();
        escrow = _escrow;
    }

    /* ─────────────── Policy ─────────────── */

    function setYieldAdapter(address token, address adapter) external onlyOwner {
        if (adapter != address(0) && IYieldAdapter(adapter).asset() != token) revert InvalidConfig();
        yieldAdapter[token] = IYieldAdapter(adapter);
        emit YieldAdapterSet(token, adapter);
    }

    /**
     * @dev Floored at 10%. A zero buffer means every payout has to unwind, which
     *      turns the venue from an optimisation into a dependency — precisely
     *      what the circuit breaker exists to avoid.
     */
    /// @param bp Freelancer's share of surplus yield, in basis points.
    function setFreelancerShare(uint256 bp) external onlyOwner {
        if (bp > 10000) revert InvalidConfig();
        freelancerShareBP = bp;
        emit FreelancerShareUpdated(bp);
    }

    function setYieldBuffer(uint256 bp) external onlyOwner {
        if (bp < 1000 || bp > 10000) revert BufferTooLow();
        yieldBufferBP = bp;
    }

    /**
     * @notice The escrow telling us a client chose this while posting.
     *
     * Their answer now decides whether they are charged a platform fee at all,
     * so it has to be settled inside the creating transaction — a second
     * signature afterwards is too late, the money has already moved. That is
     * why this exists alongside setYieldOptIn rather than replacing it:
     * setYieldOptIn is for a job whose question is still open, and this is for
     * one being answered as it is born.
     *
     * onlyEscrow, and it marks the choice made, so nobody can answer twice by
     * coming in through the other door.
     */
    /** Set by a client before posting; consumed by the escrow as it creates. */
    mapping(address => bool) public workIntent;

    /**
     * @notice Say that the next job you post should put its escrow to work.
     *
     * One flag per client, not per job, because the job does not exist yet.
     * Consumed by the very next escrow they create, so it cannot leak into a
     * later one they meant to post normally — and re-settable, since somebody
     * who changes their mind between here and posting should be able to.
     */
    function setWorkIntent(bool on) external {
        workIntent[msg.sender] = on;
        emit WorkIntentSet(msg.sender, on);
    }

    function claimIntent(address client, uint256 escrowId) external onlyEscrow returns (bool) {
        if (!workIntent[client]) return false;
        workIntent[client] = false;
        yieldChoiceMade[escrowId] = true;
        yieldOptIn[escrowId] = true;
        emit YieldOptInChanged(escrowId, true);
        return true;
    }

    /**
     * @notice Decide, once, whether this escrow works while it waits.
     *
     * THE DEPOSITOR'S CALL, AND ONLY AT THE START
     *
     * It is their capital at risk, so the answer is theirs. But it is answered
     * ONCE, before anyone is hired, and can never be changed afterwards — not
     * by the client, not by an Autopilot manager, not by us.
     *
     * WHY IT IS NOT A SWITCH
     *
     * The yield share is a term of the job. A freelancer reads "this escrow
     * earns while you work, and 60% of what it earns is yours" on the board and
     * applies partly because of it. A client who could switch that off after
     * hiring would be changing the deal after the other side had accepted it,
     * and the freelancer would have no recourse and probably no idea.
     *
     * Making it immutable removes the question entirely. Nobody has to trust
     * anybody about it, and the tag on a job card means the same thing on the
     * day the work is delivered as it did on the day it was posted.
     *
     * THE WINDOW IS "BEFORE WORK STARTS", NOT "BEFORE A BENEFICIARY EXISTS"
     *
     * The first version closed the window the moment an escrow had a
     * beneficiary, which silently excluded an entire kind of job: a directly
     * assigned escrow names its freelancer in the creating transaction, so its
     * beneficiary is never zero and its client could never answer the question
     * at all. Only the open-job path was reachable, and only the open-job path
     * had a test.
     *
     * `workStarted` is the honest line. It is the freelancer's own act — they
     * call startWork — and it is the first moment anybody is relying on the
     * terms. Before it, a client may still answer: a failed first attempt can
     * be retried, someone who thought it over overnight can still say yes, and
     * a client who adds the share after hiring is only ever making the job
     * better for the person taking it. What they cannot do, at any point, is
     * change an answer they already gave — that is the ChoiceAlreadyMade rule,
     * and it is what stops the term being withdrawn.
     */
    function setYieldOptIn(uint256 escrowId, bool optedIn) external {
        IAtelierEscrows.Escrow memory esc = IAtelierEscrows(escrow).getEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (yieldChoiceMade[escrowId]) revert ChoiceAlreadyMade();

        // Work under way means terms somebody is already relying on.
        if (esc.workStarted || esc.status != IAtelierEscrows.EscrowStatus.Pending) {
            revert TooLateToChoose();
        }

        yieldChoiceMade[escrowId] = true;
        yieldOptIn[escrowId] = optedIn;
        emit YieldOptInChanged(escrowId, optedIn);
    }

    /* ─────────────── The cap ─────────────── */

    /**
     * @notice The most this escrow may safely have lent out, right now.
     *
     * Derived from the largest claim that could arrive next, not from a
     * percentage. The first version deployed "everything except a 20% buffer"
     * and a fuzzer broke it in a few thousand calls: milestones are not 20% of
     * an escrow, so a 20% buffer cannot pay a 50% milestone when the venue is
     * down.
     *
     *   1. An OPEN job is refundable in full by cancelJob at any instant, so
     *      none of it is safe to lend.
     *   2. Once a freelancer is assigned, claims arrive one milestone at a
     *      time — so the largest unpaid milestone stays in cash.
     *   3. The percentage buffer applies on top of that, not instead of it.
     */
    function investableCeiling(uint256 escrowId) public view returns (uint256) {
        IAtelierEscrows.Escrow memory esc = IAtelierEscrows(escrow).getEscrow(escrowId);
        if (esc.depositor == address(0)) return 0;
        /*
         * NOTHING IS DEPLOYED UNTIL THE FREELANCER ACTUALLY STARTS.
         *
         * This required only that a freelancer be named. That was almost right
         * and quietly wrong: a job created with its freelancer already on it
         * deployed capital in its first block, before anyone had begun, while
         * the client could still cancel it. Cancelling does not unwind — the
         * escrow would have been asked for cash it had lent out.
         *
         * Tying it to `workStarted` makes the two rules one rule: for exactly
         * as long as the client can take their money back, all of it is
         * sitting there to be taken.
         */
        if (!esc.workStarted || esc.beneficiary == address(0)) return 0;
        if (
            esc.status != IAtelierEscrows.EscrowStatus.Pending &&
            esc.status != IAtelierEscrows.EscrowStatus.InProgress
        ) return 0;

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining == 0) return 0;

        uint256 largestClaim;
        IAtelierEscrows.Milestone[] memory ms = IAtelierEscrows(escrow).getMilestones(escrowId);
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == IAtelierEscrows.MilestoneStatus.Approved) continue;
            if (ms[i].amount > largestClaim) largestClaim = ms[i].amount;
        }

        uint256 reserve = largestClaim + (remaining * yieldBufferBP) / 10000;
        return remaining <= reserve ? 0 : remaining - reserve;
    }

    /** @notice Headroom: the ceiling minus what is already out there. */
    function investableAmount(uint256 escrowId) public view returns (uint256) {
        if (!yieldOptIn[escrowId]) return 0;

        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        if (address(yieldAdapter[token]) == address(0)) return 0;

        uint256 ceiling = investableCeiling(escrowId);
        uint256 already = escrowDeployed[escrowId];
        if (already >= ceiling) return 0;

        uint256 room = ceiling - already;
        uint256 cash = _cash(token, escrow);
        return room > cash ? cash : room;
    }

    /**
     * @notice Put one escrow's genuinely idle capital to work.
     * @dev Permissionless: it moves money only from the escrow into the venue
     *      its owner chose, never out to a caller — so there is nothing to gain
     *      by calling it and something to lose by nobody ever doing so.
     */
    function investIdle(uint256 escrowId) external nonReentrant {
        uint256 amount = investableAmount(escrowId);
        if (amount == 0) return;

        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        IYieldAdapter adapter = yieldAdapter[token];

        escrowDeployed[escrowId] += amount;
        deployedAssets[token] += amount;

        // Pull from the escrow, then forward to the venue.
        IAtelierPull(escrow).releaseToYield(token, amount);

        if (token == address(0)) {
            adapter.deposit{value: amount}(amount);
        } else {
            IERC20(token).forceApprove(address(adapter), amount);
            adapter.deposit(amount);
        }
        emit YieldDeployed(token, amount);
    }

    /* ─────────────── The escrow's two hooks ─────────────── */

    /**
     * @inheritdoc IAtelierYield
     * @dev Every failure path is swallowed on purpose. This runs immediately
     *      before a freelancer is paid, and a venue that reverts, pauses or has
     *      gone illiquid must cost us the yield and NOT the payment.
     */
    function ensureLiquid(address token, uint256 amount)
        external
        onlyEscrow
        returns (uint256 delivered)
    {
        IYieldAdapter adapter = yieldAdapter[token];
        uint256 deployed = deployedAssets[token];
        if (address(adapter) == address(0) || deployed == 0) {
            emit YieldCircuitBreakerTripped(token, amount);
            return 0;
        }

        uint256 ask = amount > deployed ? deployed : amount;
        try adapter.withdraw(ask) returns (uint256 recovered) {
            uint256 booked = recovered > deployed ? deployed : recovered;
            deployedAssets[token] = deployed - booked;
            _send(token, escrow, booked);
            emit YieldUnwound(token, ask, recovered);
            if (recovered < ask) emit YieldCircuitBreakerTripped(token, ask - recovered);
            return booked;
        } catch {
            emit YieldCircuitBreakerTripped(token, amount);
            return 0;
        }
    }

    /**
     * @inheritdoc IAtelierYield
     * @dev A cap computed at deploy time goes stale: pay the small milestone and
     *      the remainder shrinks while the largest outstanding claim does not.
     *      A fuzzer found that too. Pull the excess back, and swallow failures —
     *      this runs after a payment has already gone out.
     */
    function onObligationChanged(uint256 escrowId) external onlyEscrow {
        uint256 deployed = escrowDeployed[escrowId];
        if (deployed == 0) return;

        uint256 safe = investableCeiling(escrowId);
        if (deployed <= safe) return;

        uint256 excess = deployed - safe;
        address token = IAtelierEscrows(escrow).getEscrow(escrowId).token;
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return;

        /*
         * When this closes the position entirely, claim the earnings with it.
         *
         * A venue returns what you ask for and no more, so asking only for the
         * principal leaves the gain sitting in the adapter — and once the
         * position is closed there is no deployed balance left to attribute it
         * by. This is the last moment the escrow's share can be identified, so
         * it is the moment to collect it.
         *
         * The share is this escrow's portion of the pool's gain, by principal.
         * Not time-weighted: an escrow that deployed late gets the same rate as
         * one that deployed early. Doing better needs principal-seconds, and
         * the error only matters when deployment times differ wildly.
         */
        uint256 claim = excess;
        if (safe == 0) {
            uint256 pooled = deployedAssets[token];
            uint256 held = adapter.totalAssets();
            if (held > pooled && pooled > 0) {
                claim += ((held - pooled) * deployed) / pooled;
            }
        }

        try adapter.withdraw(claim) returns (uint256 recovered) {
            uint256 booked = recovered > deployed ? deployed : recovered;
            escrowDeployed[escrowId] = deployed - booked;
            deployedAssets[token] -= booked;
            /*
             * Anything above the principal is this escrow's earnings, and it is
             * already here — _send below forwards only the principal. Banking it
             * now is the only chance: once the position is fully unwound there
             * is no deployed balance left to attribute a share of.
             */
            if (recovered > booked) {
                escrowYield[escrowId] += recovered - booked;
                emit YieldAccrued(escrowId, recovered - booked);
            }
            _send(token, escrow, booked);
            emit YieldUnwound(token, excess, recovered);
            if (recovered < excess) emit YieldCircuitBreakerTripped(token, excess - recovered);
        } catch {
            emit YieldCircuitBreakerTripped(token, excess);
        }
    }

    /**
     * @notice Pay out what an escrow's idle capital earned, once the job is over.
     *
     * THE POINT OF THE WHOLE FEATURE
     *
     * A freelance platform normally funds itself by taxing the freelancer. This
     * one can fund itself from money that was doing nothing: escrowed capital
     * sits still between funding and approval, often for weeks. The waterfall
     * below is what turns that into a fee nobody pays.
     *
     *   1. The client's platform fee, up to the amount earned. They took the
     *      venue risk by opting in, and this is what they get for it — their fee
     *      goes to zero. Without this the client is the only party with nothing
     *      to gain, and since opting in is THEIR call, the mechanism would
     *      simply never be switched on.
     *   2. Of whatever is left, the freelancer's share. Their payment is the one
     *      that sat locked while it earned.
     *   3. The remainder to the platform.
     *
     * WHEN IT WENT TO ARBITRATION, THE PLATFORM TAKES IT ALL
     *
     * A disputed job costs the platform an arbiter and the work of settling it,
     * and the two parties have just demonstrated they disagree about who
     * deserves what. Splitting the earnings between them is an invitation to
     * argue about the split too. Sending it to the platform is the one outcome
     * neither side can game by disputing.
     *
     * Permissionless on purpose: anyone may trigger it, because the parties owed
     * money should not depend on the platform remembering to pay them.
     */
    function distributeYield(uint256 escrowId) external nonReentrant {
        if (yieldSettled[escrowId]) revert AlreadySettled();

        IAtelierEscrows.Escrow memory esc = IAtelierEscrows(escrow).getEscrow(escrowId);
        if (esc.depositor == address(0)) revert UnknownEscrow();
        // Only once the job can no longer move. A live escrow may still unwind
        // more of its position, and paying early would settle a smaller number.
        if (
            esc.status == IAtelierEscrows.EscrowStatus.Pending ||
            esc.status == IAtelierEscrows.EscrowStatus.InProgress ||
            esc.status == IAtelierEscrows.EscrowStatus.Disputed
        ) revert JobNotFinished();

        yieldSettled[escrowId] = true;

        uint256 earned = escrowYield[escrowId];
        if (earned == 0) {
            emit YieldDistributed(escrowId, 0, 0, 0);
            return;
        }
        escrowYield[escrowId] = 0;

        address token = esc.token;
        address platform = IAtelierEscrows(escrow).feeCollector();

        if (_wentToArbitration(escrowId)) {
            _send(token, platform, earned);
            emit YieldDistributed(escrowId, 0, 0, earned);
            return;
        }

        uint256 waived = earned > esc.platformFee ? esc.platformFee : earned;
        uint256 surplus = earned - waived;
        uint256 toFreelancer = (surplus * freelancerShareBP) / 10000;
        uint256 toPlatform = surplus - toFreelancer;

        if (waived > 0) _send(token, esc.depositor, waived);
        // A job that ended with nobody hired has no freelancer to pay; that
        // share follows the rest to the platform rather than being stranded.
        if (toFreelancer > 0 && esc.beneficiary != address(0)) {
            _send(token, esc.beneficiary, toFreelancer);
        } else {
            toPlatform += toFreelancer;
            toFreelancer = 0;
        }
        if (toPlatform > 0) _send(token, platform, toPlatform);

        emit YieldDistributed(escrowId, waived, toFreelancer, toPlatform);
    }

    /** True once any milestone has been disputed, settled or not. */
    function _wentToArbitration(uint256 escrowId) internal view returns (bool) {
        IAtelierEscrows.Milestone[] memory ms = IAtelierEscrows(escrow).getMilestones(escrowId);
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].disputedAt != 0 || ms[i].resolvedAt != 0) return true;
        }
        return false;
    }

    /** @notice Yield earned above principal. Zero if the venue has lost money. */
    function yieldEarned(address token) external view returns (uint256) {
        IYieldAdapter adapter = yieldAdapter[token];
        if (address(adapter) == address(0)) return 0;
        uint256 held = adapter.totalAssets();
        uint256 principal = deployedAssets[token];
        return held > principal ? held - principal : 0;
    }

    /* ─────────────── internals ─────────────── */

    function _cash(address token, address who) internal view returns (uint256) {
        return token == address(0) ? who.balance : IERC20(token).balanceOf(who);
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "native send failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    receive() external payable {}
}

/** The one call the controller makes back into the escrow. */
interface IAtelierPull {
    function releaseToYield(address token, uint256 amount) external;
}
