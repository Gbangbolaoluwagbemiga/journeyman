// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./yield/IAtelierYield.sol";

/**
 * @title Atelier
 * @dev Milestone-based escrow with on-chain ratings, deadline extension,
 *      and enumerable arbiter list — deployed on Arc EVM.
 *
 * Fee model:
 *   Client deposits totalAmount + platformFee upfront.
 *   Fee is separated immediately at creation.
 *   Milestones sum to totalAmount so the release check is exact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPGRADEABILITY (UUPS) — read this before deploying or upgrading
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This contract sits behind an ERC1967 proxy so that new features can ship
 * without migrating live escrows. Deploy the implementation, deploy the proxy
 * pointing at it, and call `initialize` through the proxy. Never call
 * `initialize` on the implementation itself — the constructor disables it.
 *
 * WHAT THAT COSTS, STATED PLAINLY. Atelier's promise is that neither party
 * can unilaterally move money once an escrow is live. Upgradeability puts one
 * asterisk on it: the owner can replace the implementation, and a malicious
 * replacement could do anything to funds already locked. That is true of every
 * upgradeable escrow, it is not hidden here, and it is the reason
 * `_authorizeUpgrade` is owner-only and `Ownable2Step` is used — a fat-fingered
 * ownership transfer cannot silently hand over the upgrade key.
 *
 * The honest framing for a client: the CONTRACT cannot take your money, and the
 * OWNER can change the contract. Do not describe this deployment as trustless
 * without that second clause.
 *
 * RULES FOR FUTURE UPGRADES — storage layout is append-only:
 *   1. Never reorder, retype, or delete an existing state variable.
 *   2. Add new variables ONLY at the end, immediately before `__gap`, and
 *      reduce `__gap`'s length by the number of slots you added.
 *   3. Adding a field to a struct held in a MAPPING is safe (values live at
 *      hashed offsets). Adding one to a struct held in an ARRAY is NOT.
 *   4. Bump `version()` in the same commit as any storage change, so a
 *      deployed proxy can be identified from chain state alone.
 *   5. Run the upgrade tests in test/AtelierUpgrade.t.sol before shipping.
 */
/*
 * ─────────────────────────────────────────────────────────────────────────────
 * A NOTE ON SIZE, kept because it shaped the architecture
 *
 * With the yield layer inlined, this contract compiled to 26.2KB against
 * EIP-170's 24,576-byte deploy limit — the feature could not ship at all.
 * Two byte-shaving attempts are recorded so nobody repeats them:
 *   - optimizer_runs 200 -> 1 saved 292 bytes. Not enough.
 *   - moving the cancellation-penalty maths into an external library made it
 *     BIGGER by 84 bytes: delegatecall boilerplate outweighs the code removed
 *     for functions that small.
 *
 * The fix was architectural, not a trim: productive escrow lives in
 * AtelierYield, reached through a single controller pointer, and the split is
 * better design anyway — custodying money and deciding where it earns are
 * different jobs with different risk profiles, and the second can now be
 * replaced or disconnected without touching the first.
 *
 * A third data point, from adding setMilestones later: the margin had drifted
 * down to 146 bytes and the new function needed 940, so it did not fit. What
 * paid for it was not a trim either — the 17-field Milestone struct literal was
 * written out twice, at creation and when rewriting the list, and collapsing
 * both into one private _pushMilestone freed ~1,473 bytes. Duplicated struct
 * literals are the cheapest thing to look for when this contract is full.
 *
 * A LESSON ABOUT THE ORDER OF THOSE TWO MOVES, which cost nothing but is worth
 * writing down: addJobFunds was deleted first, to buy 316 bytes toward the 794
 * still needed. The dedup then freed five times that, and the deletion had
 * stopped being necessary without anybody noticing. It was restored. Check
 * whether a sacrifice is still required after the real fix lands.
 * ─────────────────────────────────────────────────────────────────────────────
 */
contract Atelier is
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    /* ===================== ERRORS ===================== */
    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error EscrowNotFound();
    error InvalidEscrowStatus();
    error WorkAlreadyStarted();
    error EscrowNotActive();
    error DeadlineNotPassed();
    error InvalidMilestone();
    error MilestoneAlreadyProcessed();
    error MilestoneNotSubmitted();
    error EmergencyPeriodNotReached();
    error NothingToRefund();
    error CannotRefund();
    error TokenNotWhitelisted();
    error MilestoneSumMismatch();
    error InvalidConfig();
    error AlreadyApplied();
    error NotAnOpenJob();
    error FreelancerNotApplied();
    error AlreadyRated();
    error InvalidRating();
    error EscrowNotReleased();
    error NotParticipant();
    error ExtensionTooShort();
    error JobAlreadyAssigned();
    error CannotCancelAssignedJob();
    error NoPendingProposal();
    error ProposalAlreadyExists();
    error ManagerCannotBeBeneficiary();
    error ManagerCannotSelfHire();
    /// A rating is only worth something if the two sides are different people.
    error SelfDealing();
    /// Every milestone is already delivered or paid; there is nothing to hand on.
    error NothingLeftToFinish();
    error NoManagerSet();
    error YieldNotEnabled();
    error BufferTooLow();

    /* ===================== ENUMS & STRUCTS ===================== */
    enum EscrowStatus { Pending, InProgress, Released, Refunded, Disputed, Expired, Cancelled }
    enum MilestoneStatus { NotStarted, Submitted, Approved, Rejected, Disputed, ProposalPending }

    struct Milestone {
        uint256 amount;
        string description;       // freelancer's submission text (overwritten on submit)
        string requirements;      // original client requirements — set once at creation, never overwritten
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
        uint256 resolutionFreelancerAmount; // Amount awarded to freelancer in dispute resolution
        uint256 resolutionClientAmount;     // Amount refunded to client in dispute resolution
        string resolutionReason;            // Admin's reason for resolution decision
    }

    struct Escrow {
        address depositor;
        address beneficiary;
        address token;          // address(0) = native ETH
        uint256 totalAmount;    // net of platform fee; milestones sum to this
        uint256 paidAmount;
        uint256 deadline;
        EscrowStatus status;
        bool workStarted;
        uint256 platformFee;    // already separated at creation
        address[] arbiters;
        uint256 requiredConfirmations;
        bool isOpenJob;
        string projectTitle;
        string projectDescription;
    }

    struct Rating {
        address rater;
        address rated;
        uint8 score;        // 1-5
        string review;
        uint256 ratedAt;
    }

    /* ===================== STATE VARIABLES ===================== */
    address public feeCollector;
    uint256 public platformFeeBP;
    uint256 public constant MAX_PLATFORM_FEE_BP = 1000; // 10 %
    uint256 public constant EMERGENCY_REFUND_DELAY = 30 days;
    uint256 public constant MIN_EXTENSION_DAYS = 1;
    address public constant NATIVE_TOKEN = address(0);

    /**
     * @dev Set in `initialize`, NOT here. A declaration-site initialiser runs in
     *      the implementation's constructor, which a proxy never executes — so
     *      this would have silently started at 0 behind the proxy and made
     *      escrow id 0 both "the first escrow" and "does not exist".
     */
    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) public escrows;
    mapping(uint256 => Milestone[]) private escrowMilestones;

    // Multi-sig dispute tracking
    mapping(uint256 => mapping(address => bool)) public disputeVotes;
    mapping(uint256 => uint256) public disputeVoteCounts;

    // Platform state
    mapping(address => bool) public authorizedArbiters;
    address[] private _arbiterList;                // enumerable
    mapping(address => bool) public whitelistedTokens;
    mapping(address => uint256) public escrowedAmount;
    mapping(address => uint256) public totalFeesByToken;
    mapping(address => uint256) public completedEscrows;
    mapping(address => uint256) public reputation;

    // Ratings: escrowId → rater → Rating
    mapping(uint256 => mapping(address => Rating)) private _ratings;
    // All ratings received by an address
    mapping(address => Rating[]) private _receivedRatings;

    // User escrow tracking
    mapping(address => uint256[]) private userEscrows;
    mapping(uint256 => mapping(address => bool)) public hasApplied;
    mapping(uint256 => address[]) private escrowApplications;

    // Anti-abuse: Cancellation tracking
    mapping(address => uint256) public userCancellations;
    mapping(address => uint256) public lastCancellationTime;

    /**
     * Autopilot: a per-escrow manager who may do the LABOUR of managing a job —
     * hiring, approving, rejecting — on behalf of the depositor, and nothing
     * else.
     *
     * This exists so that a client can delegate the work of running a job to an
     * agent WITHOUT handing over the money. Before it, the only way an agent
     * could manage a job was to be the depositor itself, which made the client
     * a custodial creditor with no on-chain standing: no approval rights, and —
     * worse — no ability to dispute, since disputeMilestone admits only the
     * depositor and the beneficiary.
     *
     * THE ONE-WAY KEY, the invariant this whole feature rests on:
     *
     *     No action available to a manager can cause value to reach the manager.
     *
     * It holds structurally rather than by inspection: the only value-moving
     * call a manager has is approveMilestone, and that pays esc.beneficiary and
     * nothing else. So the guard that keeps it true is simply that a manager can
     * never BE the beneficiary — enforced at both ends, in setJobManager and in
     * acceptFreelancer, because the beneficiary of an open job is assigned after
     * the manager is appointed.
     *
     * What this does NOT prevent: a manager hiring a confederate. No contract
     * can tell an arm's-length hire from a collusive one. That risk is bounded
     * off-chain instead — the depositor keeps dispute rights, can revoke the
     * manager at any moment, and funds only one job at a time. Do not let the
     * permission table imply otherwise.
     */
    mapping(uint256 => address) public jobManager;

    /* ===================== PRODUCTIVE ESCROW ===================== */

    /**
     * Escrowed capital sits idle for weeks between a job being funded and a
     * milestone being approved. The controller at this address puts the
     * genuinely idle portion to work.
     *
     * IT LIVES IN A SEPARATE CONTRACT, and that is not only a size decision.
     * Deciding where capital earns is a different job from custodying it, with
     * a different risk profile — so it can be replaced, paused or disconnected
     * without touching the contract holding other people's money. Set it to
     * address(0) and this escrow behaves exactly as it did before the feature
     * existed.
     *
     * (It is also what brought Atelier back under EIP-170. Combined, the two
     * were 26.2KB against a 24,576-byte deploy limit — the feature could not
     * ship at all, and trimming the escrow to make room would have made this
     * contract smaller and worse.)
     *
     * THE INVARIANT, which the controller holds and this contract relies on:
     *
     *     Cash plus deployed capital never falls below what is owed.
     *
     * A failing venue can DELAY a payout. It cannot lose the money.
     */
    IAtelierYield public yieldController;


    /* ===================== EVENTS ===================== */
    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed depositor,
        address indexed beneficiary,
        address[] arbiters,
        uint256 requiredConfirmations,
        uint256 totalAmount,
        uint256 platformFee,
        address token,
        uint256 deadline,
        bool isOpenJob
    );
    event EscrowUpdated(uint256 indexed escrowId, EscrowStatus status, uint256 timestamp);
    event WorkStarted(uint256 indexed escrowId, address indexed beneficiary, uint256 timestamp);
    event DeadlineExtended(uint256 indexed escrowId, uint256 oldDeadline, uint256 newDeadline);
    event MilestoneSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed beneficiary, string description, uint256 timestamp);
    event MilestoneApproved(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed beneficiary, uint256 amount, uint256 timestamp);
    event MilestoneRejected(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed depositor, string reason, uint256 timestamp);
    event MilestoneDisputed(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed disputer, string reason, uint256 timestamp);
    event DisputeVoteCast(uint256 indexed escrowId, address indexed arbiter, uint256 voteCount);
    event DisputeResolved(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed arbiter, uint256 freelancerAmount, uint256 clientAmount, uint256 timestamp);
    event FundsRefunded(uint256 indexed escrowId, address indexed depositor, uint256 amount);
    event EmergencyRefundExecuted(uint256 indexed escrowId, address indexed depositor, uint256 amount);
    event EvidenceSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed submitter, string cid);
    event ApplicationSubmitted(uint256 indexed escrowId, address indexed freelancer, string coverLetter, uint256 proposedTimeline);
    event FreelancerAccepted(uint256 indexed escrowId, address indexed freelancer);
    event OverdueDisputeRaised(uint256 indexed escrowId, address indexed requester, string reason, uint256 timestamp);
    event RatingSubmitted(uint256 indexed escrowId, address indexed rater, address indexed rated, uint8 score);
    event ArbiterAuthorized(address indexed arbiter);
    event ArbiterRevoked(address indexed arbiter);
    event TokenWhitelisted(address indexed token);
    event TokenBlacklisted(address indexed token);
    event PlatformFeeUpdated(uint256 feeBp);
    event FeeCollectorUpdated(address indexed feeCollector);
    event FeesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event EscrowDeleted(uint256 indexed escrowId, address indexed deletedBy);
    event JobCancelled(uint256 indexed escrowId, address indexed depositor, uint256 refundAmount);
    event JobFundsUpdated(uint256 indexed escrowId, uint256 oldAmount, uint256 newAmount, bool isIncrease);
    event MilestoneProposalSubmitted(uint256 indexed escrowId, uint256 indexed milestoneIndex, address indexed freelancer, uint256 proposedAmount, string proposedDescription);
    event MilestoneProposalApproved(uint256 indexed escrowId, uint256 indexed milestoneIndex, uint256 newAmount, string newDescription);
    event MilestoneProposalRejected(uint256 indexed escrowId, uint256 indexed milestoneIndex);
    event JobManagerSet(uint256 indexed escrowId, address indexed manager);
    event JobManagerRevoked(uint256 indexed escrowId, address indexed manager);
    /// A job put back on the board after arbitration, with its history intact.
    event JobReopened(uint256 indexed escrowId, address indexed previousFreelancer);
    event YieldAdapterSet(address indexed token, address indexed adapter);
    event YieldOptInChanged(uint256 indexed escrowId, bool optedIn);
    event YieldDeployed(address indexed token, uint256 amount);
    event YieldUnwound(address indexed token, uint256 requested, uint256 recovered);
    /// The circuit breaker tripped: the venue could not return funds on demand.
    event YieldCircuitBreakerTripped(address indexed token, uint256 shortfall);

    /* ===================== MODIFIERS ===================== */
    modifier onlyArbiter() {
        _onlyArbiter();
        _;
    }
    function _onlyArbiter() internal view {
        if (!authorizedArbiters[msg.sender]) revert Unauthorized();
    }

    /**
     * @dev Callable by the depositor, or by a manager the depositor appointed.
     *
     * Guarded against the address(0) case: an unset jobManager is address(0),
     * and msg.sender is never address(0) in a real transaction, but relying on
     * that keeps a footgun one refactor away from being live.
     */
    function _onlyDepositorOrManager(Escrow storage esc, uint256 escrowId) internal view {
        if (msg.sender == esc.depositor) return;
        address mgr = jobManager[escrowId];
        if (mgr != address(0) && msg.sender == mgr) return;
        revert Unauthorized();
    }

    /* ===================== INITIALISATION ===================== */

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Locks the implementation so nobody can initialise it directly and
        // take ownership of a contract the proxy is delegating into.
        _disableInitializers();
    }

    /**
     * @notice Initialise the proxy. Replaces the constructor.
     * @dev Call this through the proxy, once, immediately after deployment.
     */
    function initialize(address _feeCollector, uint256 _platformFeeBP) external initializer {
        if (_feeCollector == address(0)) revert InvalidAddress();
        if (_platformFeeBP > MAX_PLATFORM_FEE_BP) revert InvalidConfig();

        __Ownable_init(msg.sender);
        __Ownable2Step_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        feeCollector = _feeCollector;
        platformFeeBP = _platformFeeBP;
        nextEscrowId = 1;
    }

    /**
     * @notice Identifies the deployed implementation from chain state alone.
     * @dev Bump this in the same commit as any storage-layout change.
     */
    function version() external pure virtual returns (string memory) {
        return "3.9.1-fee-follows-the-escrow";
    }

    /// @dev Only the owner may ship a new implementation. See the note above.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert InvalidAddress();
    }

    /* ===================== CORE ESCROW LOGIC ===================== */

    /**
     * @notice Create a milestone-based escrow.
     * @dev Deposit = totalAmount + platformFee. Fee is separated immediately.
     */
    function createEscrow(
        address beneficiary,
        address token,
        uint256 totalAmount,
        uint256 durationDays,
        address[] calldata arbiters,
        uint256 requiredConfirmations,
        uint256[] calldata milestoneAmounts,
        string[] calldata milestoneDescriptions,
        string calldata projectTitle,
        string calldata projectDescription
    ) external payable whenNotPaused nonReentrant returns (uint256) {
        /**
         * Hiring yourself is how a reputation gets manufactured: fund an escrow,
         * release it to yourself, rate yourself five stars, repeat. The money
         * makes a round trip minus the fee, and the rating is indistinguishable
         * on-chain from one a real client left.
         *
         * address(0) is not self-dealing -- that is how an open job is declared.
         *
         * Checked here, with the other input validation, rather than after the
         * deposit has been pulled. The transaction reverted either way, but
         * taking someone's tokens and then deciding the call was invalid is the
         * wrong order, and it made the rejection cost a full transfer in gas.
         */
        if (beneficiary == msg.sender) revert SelfDealing();

        if (totalAmount == 0) revert InvalidAmount();
        if (durationDays == 0) revert InvalidConfig();
        if (token != NATIVE_TOKEN && !whitelistedTokens[token]) revert TokenNotWhitelisted();
        if (milestoneAmounts.length == 0 || milestoneAmounts.length != milestoneDescriptions.length)
            revert InvalidConfig();
        if (arbiters.length > 0 && requiredConfirmations > arbiters.length) revert InvalidConfig();

        uint256 milestoneSum;
        for (uint256 i; i < milestoneAmounts.length; ++i) {
            if (milestoneAmounts[i] == 0) revert InvalidAmount();
            milestoneSum += milestoneAmounts[i];
        }
        if (milestoneSum != totalAmount) revert MilestoneSumMismatch();

        /*
         * PUTTING THE ESCROW TO WORK COSTS THE CLIENT NOTHING, AND THAT IS THE POINT.
         *
         * The fee used to be charged either way, with yield refunding it later.
         * That refund is worthless: a job deploys about 40% of its budget, so
         * covering a 2.5% fee needs rate x days >= 22.8 — 228 days at 10% APY,
         * and the budget cancels out entirely. No freelance job is long enough,
         * so the client's benefit rounded to zero and nobody had a reason to
         * switch it on.
         *
         * The platform gives up a certain 2.5% instead, and takes 40% of what
         * the escrow earns plus a job that carries a share for whoever takes
         * it — which is why a freelancer picks it over an identical one.
         *
         * The client's answer arrives as an intent flag set on the controller
         * beforehand rather than as an argument here. An eleventh parameter
         * was the obvious way and cost 1,143 bytes of ABI decoding on a
         * contract with 118 to spare.
         */
        // The id is taken here rather than below so it can be handed to the
        // controller and reused, instead of reading nextEscrowId twice.
        uint256 escrowId = nextEscrowId++;
        bool putToWork = address(yieldController) != address(0)
            && yieldController.claimIntent(msg.sender, escrowId);
        uint256 fee = putToWork ? 0 : (totalAmount * platformFeeBP) / 10000;
        uint256 totalDeposit = totalAmount + fee;

        if (token == NATIVE_TOKEN) {
            if (msg.value != totalDeposit) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), totalDeposit);
        }

        if (fee > 0) totalFeesByToken[token] += fee;

        bool isOpenJob = beneficiary == address(0);

        Escrow storage esc = escrows[escrowId];
        esc.depositor = msg.sender;
        esc.beneficiary = beneficiary;
        esc.token = token;
        esc.totalAmount = totalAmount;
        esc.deadline = block.timestamp + durationDays * 1 days;
        esc.status = EscrowStatus.Pending;
        esc.platformFee = fee;
        esc.arbiters = arbiters;
        esc.requiredConfirmations = requiredConfirmations == 0 ? 1 : requiredConfirmations;
        esc.isOpenJob = isOpenJob;
        esc.projectTitle = projectTitle;
        esc.projectDescription = projectDescription;

        for (uint256 i; i < milestoneAmounts.length; ++i) {
            _pushMilestone(escrowId, milestoneAmounts[i], milestoneDescriptions[i]);
        }

        escrowedAmount[token] += totalAmount;
        userEscrows[msg.sender].push(escrowId);
        if (!isOpenJob) userEscrows[beneficiary].push(escrowId);

        emit EscrowCreated(escrowId, msg.sender, beneficiary, arbiters, requiredConfirmations,
            totalAmount, fee, token, esc.deadline, isOpenJob);
        return escrowId;
    }

    function startWork(uint256 escrowId) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.beneficiary != msg.sender) revert Unauthorized();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        if (esc.workStarted) revert WorkAlreadyStarted();

        esc.workStarted = true;
        esc.status = EscrowStatus.InProgress;

        emit WorkStarted(escrowId, msg.sender, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.InProgress, block.timestamp);
    }

    /**
     * @notice Extend the deadline of an active escrow.
     * @dev Only the depositor can extend. Extension must be at least 1 day.
     */
    function extendDeadline(uint256 escrowId, uint256 additionalDays) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (esc.status != EscrowStatus.Pending && esc.status != EscrowStatus.InProgress)
            revert InvalidEscrowStatus();
        if (additionalDays < MIN_EXTENSION_DAYS) revert ExtensionTooShort();

        uint256 oldDeadline = esc.deadline;
        esc.deadline = oldDeadline + additionalDays * 1 days;

        emit DeadlineExtended(escrowId, oldDeadline, esc.deadline);
    }

    function submitMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata description)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.beneficiary != msg.sender) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted && m.status != MilestoneStatus.Rejected)
            revert MilestoneAlreadyProcessed();

        m.status = MilestoneStatus.Submitted;
        m.description = description;
        m.submittedAt = block.timestamp;

        emit MilestoneSubmitted(escrowId, milestoneIndex, msg.sender, description, block.timestamp);
    }

    function approveMilestone(uint256 escrowId, uint256 milestoneIndex)
        external nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        // Depositor, or the agent they appointed. Payment goes to esc.beneficiary
        // either way — a manager approving is paying the freelancer by
        // construction, never itself.
        _onlyDepositorOrManager(esc, escrowId);
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Approved;
        m.approvedAt = block.timestamp;

        esc.paidAmount += m.amount;
        escrowedAmount[esc.token] -= m.amount;

        if (esc.paidAmount == esc.totalAmount) {
            esc.status = EscrowStatus.Released;
            completedEscrows[esc.beneficiary]++;
            completedEscrows[esc.depositor]++;
            reputation[esc.beneficiary]++;
            emit EscrowUpdated(escrowId, EscrowStatus.Released, block.timestamp);
        }

        _doTransfer(esc.token, address(this), esc.beneficiary, m.amount);
        // What is safe to have lent out just shrank. Pull the excess back.
        _rebalanceYield(escrowId);
        emit MilestoneApproved(escrowId, milestoneIndex, esc.beneficiary, m.amount, block.timestamp);
    }

    function rejectMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata reason)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        // Rejection moves no value; it sends the milestone back for revision,
        // which is exactly the review labour Autopilot exists to do.
        _onlyDepositorOrManager(esc, escrowId);
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted) revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Rejected;
        m.rejectionReason = reason;

        emit MilestoneRejected(escrowId, milestoneIndex, msg.sender, reason, block.timestamp);
    }

    function disputeMilestone(uint256 escrowId, uint256 milestoneIndex, string calldata reason)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        /**
         * The manager may escalate, and this is not a widening of its powers.
         *
         * An Autopilot manager can approve and reject, so when its revision
         * rounds run out it has exactly two moves left: approve work it has
         * judged inadequate, or reject it again forever. Both are worse than
         * handing the decision to a person. Without this the agent's escalation
         * reverted Unauthorized on any job the client funded themselves -- the
         * agent is the manager there, not the depositor -- and the job stuck
         * with nobody paid and nothing refunded.
         *
         * It cannot pay itself by escalating. An arbiter may award only the
         * freelancer or the client, so the one-way key holds: this hands the
         * decision away rather than taking it.
         */
        if (
            msg.sender != esc.depositor && msg.sender != esc.beneficiary
                && msg.sender != jobManager[escrowId]
        ) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.Submitted && m.status != MilestoneStatus.Rejected)
            revert MilestoneNotSubmitted();

        m.status = MilestoneStatus.Disputed;
        m.disputedAt = block.timestamp;
        m.disputedBy = msg.sender;
        m.disputeReason = reason;
        esc.status = EscrowStatus.Disputed;

        emit MilestoneDisputed(escrowId, milestoneIndex, msg.sender, reason, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.Disputed, block.timestamp);
    }

    function raiseOverdueDispute(uint256 escrowId, string calldata reason) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor && msg.sender != esc.beneficiary) revert Unauthorized();
        if (block.timestamp <= esc.deadline) revert DeadlineNotPassed();
        if (esc.status == EscrowStatus.Released ||
            esc.status == EscrowStatus.Refunded ||
            esc.status == EscrowStatus.Expired) revert CannotRefund();

        esc.status = EscrowStatus.Disputed;
        emit OverdueDisputeRaised(escrowId, msg.sender, reason, block.timestamp);
        emit EscrowUpdated(escrowId, EscrowStatus.Disputed, block.timestamp);
    }

    /**
     * @notice Multi-sig arbiter dispute resolution.
     * @param reason Admin's reason for the resolution decision (required)
     */
    function resolveDispute(
        uint256 escrowId,
        uint256 milestoneIndex,
        uint256 freelancerAmount,
        uint256 clientAmount,
        string calldata reason
    ) external onlyArbiter nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.status != EscrowStatus.Disputed) revert InvalidEscrowStatus();
        if (bytes(reason).length == 0) revert InvalidConfig(); // Reason is required

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (freelancerAmount + clientAmount != m.amount) revert InvalidAmount();

        if (!disputeVotes[escrowId][msg.sender]) {
            disputeVotes[escrowId][msg.sender] = true;
            disputeVoteCounts[escrowId]++;
            emit DisputeVoteCast(escrowId, msg.sender, disputeVoteCounts[escrowId]);
        }

        if (disputeVoteCounts[escrowId] < esc.requiredConfirmations) return;

        m.status = MilestoneStatus.Approved;
        m.resolvedAt = block.timestamp;
        m.resolvedBy = msg.sender;
        m.resolutionFreelancerAmount = freelancerAmount;
        m.resolutionClientAmount = clientAmount;
        m.resolutionReason = reason;

        esc.paidAmount += freelancerAmount;
        esc.totalAmount -= clientAmount;
        escrowedAmount[esc.token] -= m.amount;

        if (esc.paidAmount == esc.totalAmount) {
            esc.status = EscrowStatus.Released;
            emit EscrowUpdated(escrowId, EscrowStatus.Released, block.timestamp);
        } else {
            esc.status = EscrowStatus.InProgress;
            emit EscrowUpdated(escrowId, EscrowStatus.InProgress, block.timestamp);
        }

        if (freelancerAmount > 0) _doTransfer(esc.token, address(this), esc.beneficiary, freelancerAmount);
        if (clientAmount > 0) _doTransfer(esc.token, address(this), esc.depositor, clientAmount);
        // A resolution moves paidAmount and totalAmount both, so the safe level
        // moves too. Same reason as approveMilestone.
        _rebalanceYield(escrowId);

        emit DisputeResolved(escrowId, milestoneIndex, msg.sender, freelancerAmount, clientAmount, block.timestamp);
    }

    function emergencyRefundAfterDeadline(uint256 escrowId) external nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.depositor != msg.sender) revert Unauthorized();
        if (block.timestamp <= esc.deadline + EMERGENCY_REFUND_DELAY) revert EmergencyPeriodNotReached();
        if (esc.status == EscrowStatus.Released ||
            esc.status == EscrowStatus.Refunded ||
            esc.status == EscrowStatus.Expired) revert CannotRefund();

        uint256 refundAmount = esc.totalAmount - esc.paidAmount;
        if (refundAmount == 0) revert NothingToRefund();

        esc.status = EscrowStatus.Expired;
        escrowedAmount[esc.token] -= refundAmount;

        _doTransfer(esc.token, address(this), esc.depositor, refundAmount);
        emit EmergencyRefundExecuted(escrowId, msg.sender, refundAmount);
        emit EscrowUpdated(escrowId, EscrowStatus.Expired, block.timestamp);
    }

    function submitEvidence(uint256 escrowId, uint256 milestoneIndex, string calldata cid) external {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor && msg.sender != esc.beneficiary) revert Unauthorized();
        emit EvidenceSubmitted(escrowId, milestoneIndex, msg.sender, cid);
    }

    /**
     * @notice Put the unfinished part of an arbitrated job back on the board.
     *
     * The alternative to taking the money back. A dispute means this client and
     * this freelancer are done, but it does not mean the work stopped being
     * worth doing — and the client may prefer the job finished to refunded.
     *
     * WHAT THE NEXT FREELANCER INHERITS
     *
     * Everything, and that is the point. Nothing is erased: the previous
     * freelancer's submissions stay on their milestones, the dispute reason and
     * the arbiter's ruling stay where they were written, and the evidence trail
     * is untouched. So whoever picks this up can read what was delivered, what
     * the disagreement was, and how it was settled, before deciding whether
     * they can finish it. A job reopened with its history hidden would just be
     * a trap with a budget attached.
     *
     * Only milestones nobody has submitted are back in play. Paid work stays
     * paid, and delivered-but-unapproved work stays with the milestone it
     * belongs to.
     */
    function reopenJob(uint256 escrowId) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        /*
         * Two ways a job comes back to the board, and they end in the same
         * state, so they share the body.
         *
         *   after arbitration — the job broke and there is work left
         *   after a decline   — the named freelancer handed it back
         *
         * The second is one of the three answers to a decline; the other two,
         * naming somebody and taking the money back, are acceptFreelancer and
         * cancelJob. It lives here rather than in a function of its own because
         * the runtime has 44 bytes of EIP-170 left and this body already exists.
         */
        bool declined = esc.status == EscrowStatus.Pending && esc.beneficiary == address(0);
        bool arbitrated =
            esc.status == EscrowStatus.InProgress && disputeVoteCounts[escrowId] > 0;
        if (!declined && !arbitrated) revert CannotCancelAssignedJob();

        Milestone[] storage ms = escrowMilestones[escrowId];
        bool unfinished;
        for (uint256 i; i < ms.length; ++i) {
            if (ms[i].status == MilestoneStatus.NotStarted && ms[i].amount > 0) unfinished = true;
        }
        if (!unfinished) revert NothingLeftToFinish();

        address previous = esc.beneficiary;
        _removeFromUserEscrows(previous, escrowId);

        esc.beneficiary = address(0);
        esc.isOpenJob = true;
        esc.workStarted = false;
        esc.status = EscrowStatus.Pending;

        emit JobReopened(escrowId, previous);
        emit EscrowUpdated(escrowId, EscrowStatus.Pending, block.timestamp);
    }

    /* ===================== RATINGS ===================== */

    /**
     * @notice Submit a 1-5 star rating after the escrow is fully released.
     * @dev Each participant may rate the other exactly once per escrow.
     */
    function submitRating(uint256 escrowId, uint8 score, string calldata review) external {
        if (score < 1 || score > 5) revert InvalidRating();

        Escrow storage esc = _requireEscrow(escrowId);
        if (esc.status != EscrowStatus.Released) revert EscrowNotReleased();

        bool isDepositor = msg.sender == esc.depositor;
        bool isBeneficiary = msg.sender == esc.beneficiary;
        if (!isDepositor && !isBeneficiary) revert NotParticipant();

        if (_ratings[escrowId][msg.sender].ratedAt != 0) revert AlreadyRated();

        address rated = isDepositor ? esc.beneficiary : esc.depositor;
        // Unreachable while the two checks above hold. Kept because this is the
        // function whose output people trust, and it should not depend on
        // another function having been written correctly.
        if (rated == msg.sender) revert SelfDealing();

        Rating memory r = Rating({
            rater: msg.sender,
            rated: rated,
            score: score,
            review: review,
            ratedAt: block.timestamp
        });

        _ratings[escrowId][msg.sender] = r;
        _receivedRatings[rated].push(r);

        emit RatingSubmitted(escrowId, msg.sender, rated, score);
    }

    /* ===================== OPEN JOB LOGIC ===================== */

    function applyToJob(uint256 escrowId, string calldata coverLetter, uint256 proposedTimeline)
        external whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (!esc.isOpenJob) revert NotAnOpenJob();
        if (hasApplied[escrowId][msg.sender]) revert AlreadyApplied();

        hasApplied[escrowId][msg.sender] = true;
        escrowApplications[escrowId].push(msg.sender);

        emit ApplicationSubmitted(escrowId, msg.sender, coverLetter, proposedTimeline);
    }

    function acceptFreelancer(uint256 escrowId, address freelancer) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        _onlyDepositorOrManager(esc, escrowId);
        /*
         * "Nobody is on this job" rather than "this job is open".
         *
         * The two agree on every open job — an open one has no beneficiary
         * until this function gives it one. They differ on a job that was
         * declined, which has no beneficiary and is not open, and which the
         * client must be able to fill without first pushing it to the board.
         */
        if (esc.beneficiary != address(0)) revert NotAnOpenJob();
        if (!hasApplied[escrowId][freelancer]) revert FreelancerNotApplied();
        if (freelancer == address(0)) revert InvalidAddress();

        /**
         * THE ONE-WAY KEY, second enforcement point.
         *
         * setJobManager checks manager != beneficiary, but on an open job the
         * beneficiary is not known yet — it is assigned right here. Without this
         * check a manager could appoint itself the freelancer and then approve
         * its own milestones, which is the entire attack the invariant exists to
         * stop.
         *
         * Checked against the stored manager rather than against msg.sender, so
         * it holds no matter who calls: a depositor cannot accidentally hire
         * their own agent as the worker either.
         */
        if (freelancer == jobManager[escrowId]) revert ManagerCannotSelfHire();

        // The same self-dealing route, one step later: an open job the depositor
        // applies to and then awards to themselves.
        if (freelancer == esc.depositor) revert SelfDealing();

        esc.beneficiary = freelancer;
        esc.isOpenJob = false;
        userEscrows[freelancer].push(escrowId);

        emit FreelancerAccepted(escrowId, freelancer);
    }

    /* ===================== AUTOPILOT: SCOPED JOB MANAGER ===================== */

    /**
     * @notice Appoint an agent to manage this job on your behalf.
     * @dev Depositor only. The manager may hire, approve and reject. It may not
     *      dispute, cancel, extend, add or withdraw funds, re-appoint, or become
     *      the beneficiary — see the jobManager mapping for the invariant.
     *
     *      Appointing a new manager replaces the previous one outright; there is
     *      deliberately no list. One job, one manager, so "who did this" always
     *      has exactly one answer.
     */
    function setJobManager(uint256 escrowId, address manager) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (manager == address(0)) revert InvalidAddress();

        // Paying yourself to manage your own job is a configuration mistake, and
        // silently accepting it would leave a manager set that nobody expects.
        if (manager == esc.depositor) revert InvalidAddress();

        // THE ONE-WAY KEY. A manager that is also the beneficiary could approve
        // its own milestones and drain the escrow to itself.
        if (manager == esc.beneficiary) revert ManagerCannotBeBeneficiary();

        jobManager[escrowId] = manager;
        emit JobManagerSet(escrowId, manager);
    }

    /**
     * @notice Take back management of this job, immediately.
     * @dev Depositor only. Effective on the next call — a revoked manager's very
     *      next transaction reverts. This is the client's escape hatch and must
     *      never depend on the manager's cooperation or on a timelock.
     */
    function revokeJobManager(uint256 escrowId) external {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        address mgr = jobManager[escrowId];
        if (mgr == address(0)) revert NoManagerSet();

        delete jobManager[escrowId];
        emit JobManagerRevoked(escrowId, mgr);
    }

    /// @notice Whether `who` may currently manage `escrowId`.
    function isJobManager(uint256 escrowId, address who) external view returns (bool) {
        return who != address(0) && jobManager[escrowId] == who;
    }

    /* ===================== PRODUCTIVE ESCROW ===================== */

    /**
     * @notice Point this escrow at a yield controller, or at nothing.
     * @dev address(0) disables productive escrow entirely and is the safe
     *      default. Everything else about yield — venues, buffers, opt-in,
     *      accounting — is the controller's business.
     */
    function setYieldController(address controller) external onlyOwner {
        yieldController = IAtelierYield(controller);
    }

    /**
     * @notice Hand capital to the yield controller for deployment.
     * @dev Callable ONLY by the controller, which computes what is safe to
     *      lend from this escrow's own remaining obligations. The escrow does
     *      not decide the amount; it only refuses to let anybody else ask.
     */
    function releaseToYield(address token, uint256 amount) external nonReentrant {
        if (msg.sender != address(yieldController)) revert Unauthorized();
        _doTransferRaw(token, msg.sender, amount);
    }

    /* ===================== JOB MANAGEMENT (BEFORE ASSIGNMENT) ===================== */

    /**
     * @notice Cancel an open job and refund the depositor (only if no freelancer assigned)
     * @dev Implements tiered penalty system to prevent abuse:
     *      - Cancellations 0-2: 0% penalty (free)
     *      - Cancellations 3-5: 5% penalty
     *      - Cancellations 6-10: 10% penalty
     *      - Cancellations 11+: 15% penalty
     *      Additional penalty based on number of applications received
     */
    /**
     * @notice Hand back a job you were named on, before you start it.
     *
     * A directly assigned escrow puts someone's name on a job they never
     * agreed to. Their only ways out were to ignore it — leaving the client's
     * money locked and the client waiting on someone who was never coming — or
     * to start work they did not want. Neither is consent.
     *
     * Declining turns the escrow into an open job: the money stays exactly
     * where it is, the client keeps their brief and their milestones, and
     * anybody can now apply. That is better for both sides than a refund,
     * because the client usually wants the work done rather than their deposit
     * back.
     *
     * @dev The reason is deliberately NOT a parameter. Calldata is cheap but
     *      the runtime is 420 bytes from EIP-170, and a freelancer's "I'm
     *      booked until March" belongs in the message thread where the client
     *      can reply to it, not in an event nobody reads. The UI sends it there.
     */
    function declineAssignment(uint256 escrowId) external nonReentrant whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.beneficiary) revert Unauthorized();
        if (esc.workStarted) revert WorkAlreadyStarted();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();

        /*
         * The decline does not decide what happens next — the client does.
         *
         * Putting the job straight back on the board took that choice away.
         * A client who named someone specific may want to fix whatever the
         * problem was and ask them again, may want anyone at all, or may want
         * their money back; only they know which. So this leaves the escrow in
         * the one state that means "declined, waiting on the client":
         * Pending, funded, with no beneficiary and not yet open.
         *
         * Recording the decliner as an applicant is what makes the first of
         * those three possible. It costs nothing — the mapping already exists —
         * and it means `acceptFreelancer` can name them again without their
         * having to go through an application for a job they were offered.
         */
        hasApplied[escrowId][msg.sender] = true;
        esc.beneficiary = address(0);
        emit JobReopened(escrowId, msg.sender);
    }

    function cancelJob(uint256 escrowId) external nonReentrant whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        /**
         * WHILE NOBODY HAS STARTED, THE MONEY IS STILL THE CLIENT'S.
         *
         * This read `!esc.isOpenJob`, which meant a job created with its
         * freelancer already named could never be cancelled at all — its
         * `isOpenJob` is false from the first block. The client's budget was
         * locked until the deadline plus the emergency delay, on a job nobody
         * had touched. That is the same trapped-funds shape as the post-dispute
         * bug, arrived at from a different direction.
         *
         * `workStarted` is the line, as it is for the yield term: it is the
         * freelancer's own act, and the first moment anyone is relying on the
         * job. The cost is real and worth stating — a freelancer who was named
         * or accepted, and has not yet started, can be dropped. Weighed against
         * a client's money being unreachable for a fortnight on a job that
         * never began, that is the better failure.
         */
        if (esc.workStarted) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();

        // Track cancellation
        userCancellations[msg.sender]++;
        lastCancellationTime[msg.sender] = block.timestamp;

        /*
         * NO APPLICATIONS, NO PENALTY.
         *
         * The cancellation fee exists so a client cannot waste people's time:
         * post a job, let freelancers write applications, pull it. On a job
         * nobody applied to, nobody spent anything — and the case that made
         * this obvious is a client stranded by a freelancer who was named,
         * never started, and never will. Charging them 5% of their own budget
         * for someone else's silence is a fee for being let down.
         *
         * Directly assigned jobs have no applications by construction, so this
         * covers the ghosting case exactly, without needing to store when the
         * assignment happened or guess how long is long enough to wait.
         */
        uint256 penalty = escrowApplications[escrowId].length == 0
            ? 0
            : _calculateCancellationPenalty(msg.sender, escrowId);
        uint256 refundAmount = esc.totalAmount;
        uint256 feeRefund = esc.platformFee;
        
        // Deduct penalty from refund
        uint256 netRefund = refundAmount > penalty ? refundAmount - penalty : 0;
        uint256 totalRefund = netRefund + feeRefund;

        esc.status = EscrowStatus.Cancelled;
        escrowedAmount[esc.token] -= refundAmount;
        totalFeesByToken[esc.token] -= feeRefund;
        
        // Add penalty to platform fees
        if (penalty > 0) {
            totalFeesByToken[esc.token] += penalty;
        }

        _doTransfer(esc.token, address(this), esc.depositor, totalRefund);

        emit JobCancelled(escrowId, msg.sender, totalRefund);
        emit EscrowUpdated(escrowId, EscrowStatus.Cancelled, block.timestamp);
    }

    /**
     * @notice Calculate cancellation penalty based on user's history
     * @dev Tiered system with application-based penalties
     */
    /**
     * What it costs to pull a job down, and who it is actually for.
     *
     * ONLY THE APPLICANT FEE SURVIVES, AND IT IS THE ONE WITH A VICTIM.
     *
     * There used to be a second, separate charge: a tier on the client's own
     * cancellation count, decaying by one every thirty days. It read as part of
     * the same fee and was not — the tier forgave the first two cancellations
     * and the applicant fee never did — which I got wrong once while writing a
     * test for it.
     *
     * It also had no one to compensate. A client who pulls a job nobody applied
     * to has cost nobody anything, and charging them for a pattern rather than
     * for harm is a fine, not a fee. The applicant charge has someone on the
     * other end of it: a person who wrote an application that just became
     * worthless.
     *
     * Giving it up bought the room to waive the platform fee for a client who
     * puts their escrow to work, which is a benefit somebody actually receives.
     *
     * `userCancellations` and `lastCancellationTime` are still written. They are
     * a public record of behaviour and the storage slots cannot be reclaimed
     * from a live proxy anyway.
     */
    function _calculateCancellationPenalty(address, uint256 escrowId)
        internal view returns (uint256)
    {
        uint256 applicationCount = escrowApplications[escrowId].length;
        uint256 pct;
        if (applicationCount >= 11) {
            pct = 15;
        } else if (applicationCount >= 6) {
            pct = 10;
        } else if (applicationCount >= 1) {
            pct = 5;
        } else {
            return 0;
        }
        return (escrows[escrowId].totalAmount * pct) / 100;
    }

    /**
     * @notice Rewrite the milestone list on a job nobody has started.
     * @dev Add, remove, reorder and re-word in one call, settling the change in
     *      total either way. This REPLACES addJobFunds, which could only grow a
     *      milestone that already existed: adding a stage meant cancelling the
     *      job and posting it again, and cancellation is priced to discourage
     *      exactly that — free three times, then 5%, 10%, 15%, plus a penalty
     *      scaled to the applications already received. Wanting a second
     *      milestone is not abuse, and should not cost a client their fee.
     *
     *      Wholesale replacement is safe here precisely BECAUSE nothing has
     *      started. Every milestone is NotStarted, so no index is in flight for
     *      submit, approve or dispute to be silently re-pointed by — which is
     *      the trap that makes editing an array of milestones dangerous at any
     *      other moment in a job's life.
     *
     *      Guards are addJobFunds': the depositor only, before work starts,
     *      while the escrow is Pending.
     */
    function setMilestones(
        uint256 escrowId,
        uint256[] calldata amounts,
        string[] calldata requirements
    ) external payable nonReentrant whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        if (esc.workStarted) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        uint256 n = amounts.length;
        if (n == 0 || n != requirements.length) revert InvalidConfig();

        uint256 newTotal;
        for (uint256 i; i < n; ++i) newTotal += amounts[i];
        if (newTotal == 0) revert InvalidAmount();

        uint256 oldTotal = esc.totalAmount;
        if (newTotal > oldTotal) {
            uint256 add = newTotal - oldTotal;
            uint256 addFee = _feeShare(esc, add);
            if (esc.token == NATIVE_TOKEN) {
                if (msg.value != add + addFee) revert InvalidAmount();
            } else {
                if (msg.value != 0) revert InvalidAmount();
                IERC20(esc.token).safeTransferFrom(msg.sender, address(this), add + addFee);
            }
            esc.platformFee += addFee;
            escrowedAmount[esc.token] += add;
            totalFeesByToken[esc.token] += addFee;
        } else if (newTotal < oldTotal) {
            if (msg.value != 0) revert InvalidAmount();
            uint256 back = oldTotal - newTotal;
            // The fee follows the money, at the rate this escrow actually pays.
            uint256 feeBack = _feeShare(esc, back);
            esc.platformFee -= feeBack;
            escrowedAmount[esc.token] -= back;
            totalFeesByToken[esc.token] -= feeBack;
            _doTransfer(esc.token, address(this), esc.depositor, back + feeBack);
        } else {
            if (msg.value != 0) revert InvalidAmount();
        }

        delete escrowMilestones[escrowId];
        for (uint256 i; i < n; ++i) {
            _pushMilestone(escrowId, amounts[i], requirements[i]);
        }
        esc.totalAmount = newTotal;
        emit JobFundsUpdated(escrowId, oldTotal, newTotal, newTotal > oldTotal);
    }

    /**
     * @notice Add more funds to one milestone of a job nobody has started.
     * @dev KEPT ALONGSIDE setMilestones, deliberately, after being removed and
     *      put back. It was removed to make room — setMilestones needed 940
     *      bytes and there were 146 — and then deduplicating the Milestone
     *      struct literal freed 1,473, at which point the reason had gone and
     *      the removal had not.
     *
     *      It earns its place on safety, not just on space. This takes a DELTA:
     *      it cannot drop a stage, because it never names the ones it is not
     *      touching. setMilestones takes the whole list, so a caller working
     *      from a stale or failed read can silently delete work the client
     *      still wanted. For "put another 10 in", the narrow call is the one
     *      that cannot go wrong, and the general one is there for the job it
     *      was actually built for.
     * @param milestoneIndex The milestone that receives the additional funds.
     */
    function addJobFunds(uint256 escrowId, uint256 additionalAmount, uint256 milestoneIndex)
        external payable nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();
        // Same rule as cancelJob: before work starts, the job is still the
        // client's to adjust.
        if (esc.workStarted) revert CannotCancelAssignedJob();
        if (esc.status != EscrowStatus.Pending) revert InvalidEscrowStatus();
        if (additionalAmount == 0) revert InvalidAmount();

        // Validate milestone index before any state changes
        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();

        uint256 additionalFee = _feeShare(esc, additionalAmount);
        uint256 totalDeposit = additionalAmount + additionalFee;

        if (esc.token == NATIVE_TOKEN) {
            if (msg.value != totalDeposit) revert InvalidAmount();
        } else {
            if (msg.value != 0) revert InvalidAmount();
            IERC20(esc.token).safeTransferFrom(msg.sender, address(this), totalDeposit);
        }

        uint256 oldTotal = esc.totalAmount;
        esc.totalAmount += additionalAmount;
        esc.platformFee += additionalFee;
        m.amount += additionalAmount; // keep sum invariant

        escrowedAmount[esc.token] += additionalAmount;
        totalFeesByToken[esc.token] += additionalFee;

        emit JobFundsUpdated(escrowId, oldTotal, esc.totalAmount, true);
    }

    /**
     * @notice Withdraw funds from a specific milestone on an open job
     *         (before freelancer is assigned). Reduces both totalAmount and
     *         the chosen milestone's amount to keep the sum invariant.
     * @param milestoneIndex The milestone to reduce.
     */
    function withdrawJobFunds(uint256 escrowId, uint256 withdrawAmount, uint256 milestoneIndex)
        external nonReentrant whenNotPaused
    {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        /**
         * Two ways to be allowed here.
         *
         * Before the freelancer starts, this is ordinary fund management on a
         * job nobody has begun. After arbitration, it is the exit from a job that has visibly
         * broken — and that case had no exit at all. A dispute settles one
         * milestone, not the job: the escrow returned to InProgress with the
         * remaining milestones funded and unreachable, because cancelJob and
         * this function both refused an assigned job, and disputeMilestone
         * refuses a milestone nobody submitted. The client's only route was to
         * wait out the deadline plus the emergency delay.
         *
         * A settled dispute is identifiable without new storage: votes are
         * never reset, and the status only returns to InProgress once a
         * resolution has gone through.
         *
         * The milestone check below is what keeps this fair. Only work nobody
         * has submitted can be taken back, so it costs the freelancer nothing
         * they earned — anything already delivered still goes through review or
         * arbitration.
         */
        bool beforeWorkStarts = !esc.workStarted && esc.status == EscrowStatus.Pending;
        bool afterArbitration =
            esc.status == EscrowStatus.InProgress && disputeVoteCounts[escrowId] > 0;
        if (!beforeWorkStarts && !afterArbitration) revert CannotCancelAssignedJob();
        if (withdrawAmount == 0 || withdrawAmount > esc.totalAmount) revert InvalidAmount();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();
        if (withdrawAmount > m.amount) revert InvalidAmount(); // can't reduce below zero

        uint256 feeToRefund = _feeShare(esc, withdrawAmount);
        uint256 oldTotal = esc.totalAmount;

        esc.totalAmount -= withdrawAmount;
        esc.platformFee -= feeToRefund;
        m.amount -= withdrawAmount; // keep sum invariant

        escrowedAmount[esc.token] -= withdrawAmount;
        totalFeesByToken[esc.token] -= feeToRefund;

        uint256 totalWithdraw = withdrawAmount + feeToRefund;
        _doTransfer(esc.token, address(this), esc.depositor, totalWithdraw);

        emit JobFundsUpdated(escrowId, oldTotal, esc.totalAmount, false);
    }

    /* ===================== MILESTONE NEGOTIATION ===================== */

    /**
     * @notice Freelancer proposes changes to a milestone
     */
    function proposeMilestoneChange(
        uint256 escrowId,
        uint256 milestoneIndex,
        uint256 proposedAmount,
        string calldata proposedDescription
    ) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.beneficiary) revert Unauthorized();
        if (esc.status != EscrowStatus.InProgress && esc.status != EscrowStatus.Pending) revert EscrowNotActive();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.NotStarted) revert MilestoneAlreadyProcessed();
        if (proposedAmount == 0) revert InvalidAmount();

        m.proposedAmount = proposedAmount;
        m.proposedDescription = proposedDescription;
        m.status = MilestoneStatus.ProposalPending;

        emit MilestoneProposalSubmitted(escrowId, milestoneIndex, msg.sender, proposedAmount, proposedDescription);
    }

    /**
     * @notice Client approves the proposed milestone changes
     */
    function approveMilestoneProposal(uint256 escrowId, uint256 milestoneIndex) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.ProposalPending) revert NoPendingProposal();

        // Update milestone with proposed values
        m.amount = m.proposedAmount;
        m.description = m.proposedDescription;
        m.status = MilestoneStatus.NotStarted;

        // Clear proposal data
        m.proposedAmount = 0;
        m.proposedDescription = "";

        emit MilestoneProposalApproved(escrowId, milestoneIndex, m.amount, m.description);
    }

    /**
     * @notice Client rejects the proposed milestone changes
     */
    function rejectMilestoneProposal(uint256 escrowId, uint256 milestoneIndex) external whenNotPaused {
        Escrow storage esc = _requireEscrow(escrowId);
        if (msg.sender != esc.depositor) revert Unauthorized();

        Milestone storage m = _getMilestone(escrowId, milestoneIndex);
        if (m.status != MilestoneStatus.ProposalPending) revert NoPendingProposal();

        // Revert to NotStarted status
        m.status = MilestoneStatus.NotStarted;
        m.proposedAmount = 0;
        m.proposedDescription = "";

        emit MilestoneProposalRejected(escrowId, milestoneIndex);
    }

    /* ===================== ADMIN LOGIC ===================== */

    function authorizeArbiter(address arbiter) external onlyOwner {
        if (arbiter == address(0)) revert InvalidAddress();
        if (!authorizedArbiters[arbiter]) {
            authorizedArbiters[arbiter] = true;
            _arbiterList.push(arbiter);
            emit ArbiterAuthorized(arbiter);
        }
    }

    function revokeArbiter(address arbiter) external onlyOwner {
        if (authorizedArbiters[arbiter]) {
            authorizedArbiters[arbiter] = false;
            // Remove from enumerable list
            uint256 len = _arbiterList.length;
            for (uint256 i; i < len; ++i) {
                if (_arbiterList[i] == arbiter) {
                    _arbiterList[i] = _arbiterList[len - 1];
                    _arbiterList.pop();
                    break;
                }
            }
            emit ArbiterRevoked(arbiter);
        }
    }

    function whitelistToken(address token) external onlyOwner {
        whitelistedTokens[token] = true;
        emit TokenWhitelisted(token);
    }

    function blacklistToken(address token) external onlyOwner {
        whitelistedTokens[token] = false;
        emit TokenBlacklisted(token);
    }

    /**
     * @notice Permanently delete an escrow record (owner only).
     * @dev Requires zero remaining funds — i.e. all value has been paid out,
     *      refunded, or the escrow was cancelled with nothing deposited.
     *      Status must be Released, Refunded, Expired, or Cancelled.
     *      This deletes the storage slot; the escrow ID can never be reused.
     */
    function deleteEscrow(uint256 escrowId) external onlyOwner nonReentrant {
        Escrow storage esc = _requireEscrow(escrowId);

        // Must be in a terminal state with no funds remaining
        bool isTerminal = (
            esc.status == EscrowStatus.Released  ||
            esc.status == EscrowStatus.Refunded  ||
            esc.status == EscrowStatus.Expired   ||
            esc.status == EscrowStatus.Cancelled
        );
        if (!isTerminal) revert InvalidEscrowStatus();

        uint256 remaining = esc.totalAmount - esc.paidAmount;
        if (remaining > 0) revert InvalidAmount(); // funds still locked

        delete escrows[escrowId];
        // Remove from depositor and beneficiary index arrays
        _removeFromUserEscrows(esc.depositor, escrowId);
        if (esc.beneficiary != address(0)) {
            _removeFromUserEscrows(esc.beneficiary, escrowId);
        }

        emit EscrowDeleted(escrowId, msg.sender);
    }

    function setPlatformFee(uint256 _platformFeeBP) external onlyOwner {
        if (_platformFeeBP > MAX_PLATFORM_FEE_BP) revert InvalidConfig();
        platformFeeBP = _platformFeeBP;
        emit PlatformFeeUpdated(_platformFeeBP);
    }

    function setFeeCollector(address _feeCollector) external onlyOwner {
        if (_feeCollector == address(0)) revert InvalidAddress();
        feeCollector = _feeCollector;
        emit FeeCollectorUpdated(_feeCollector);
    }

    function withdrawFees(address token) external nonReentrant {
        if (msg.sender != feeCollector) revert Unauthorized();
        uint256 amount = totalFeesByToken[token];
        if (amount == 0) revert InvalidAmount();

        totalFeesByToken[token] = 0;
        _doTransfer(token, address(this), feeCollector, amount);
        emit FeesWithdrawn(token, amount, feeCollector);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /* ===================== VIEW FUNCTIONS ===================== */

    function getEscrow(uint256 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    function getMilestones(uint256 escrowId) external view returns (Milestone[] memory) {
        return escrowMilestones[escrowId];
    }

    function getUserEscrows(address user) external view returns (uint256[] memory) {
        return userEscrows[user];
    }

    function getEscrowApplications(uint256 escrowId) external view returns (address[] memory) {
        return escrowApplications[escrowId];
    }

    function getApplicationCount(uint256 escrowId) external view returns (uint256) {
        return escrowApplications[escrowId].length;
    }

    function getMilestoneCount(uint256 escrowId) external view returns (uint256) {
        return escrowMilestones[escrowId].length;
    }

    /** @notice Returns all currently authorized arbiters. */
    function getArbiters() external view returns (address[] memory) {
        return _arbiterList;
    }

    /** @notice Returns all ratings received by an address. */
    function getRatingsForAddress(address addr) external view returns (Rating[] memory) {
        return _receivedRatings[addr];
    }

    /**
     * @notice Returns average rating (scaled ×100) and count for an address.
     *         e.g. average = 450 means 4.50 stars.
     */
    function getAverageRating(address addr) external view returns (uint256 averageX100, uint256 count) {
        Rating[] storage ratings = _receivedRatings[addr];
        count = ratings.length;
        if (count == 0) return (0, 0);
        uint256 total;
        for (uint256 i; i < count; ++i) total += ratings[i].score;
        averageX100 = (total * 100) / count;
    }

    /** @notice Returns the rating a specific rater gave in an escrow (0 if not rated). */
    function getRating(uint256 escrowId, address rater) external view returns (Rating memory) {
        return _ratings[escrowId][rater];
    }

    /**
     * @notice Compute the total deposit required (totalAmount + fee).
     */
    function quoteDeposit(uint256 totalAmount) external view returns (uint256 deposit, uint256 fee) {
        fee = (totalAmount * platformFeeBP) / 10000;
        deposit = totalAmount + fee;
    }

    /* ===================== INTERNAL HELPERS ===================== */

    /**
     * @dev The one place a milestone is created. Written twice — once at
     *      creation, once when a client rewrites the list — and a 17-field
     *      struct literal is expensive enough that duplicating it cost more
     *      than the function it was blocking. Pushing the zero-value struct and
     *      assigning the two fields that are not zero is also smaller than
     *      spelling out fifteen zeroes.
     */
    /**
     * @dev What fee belongs to `part` of this escrow, at the rate this escrow
     *      actually pays.
     *
     * NOT platformFeeBP. A job put to work has its fee waived outright at
     * creation — `fee = putToWork ? 0 : ...` — and three functions that adjust
     * a funded job all assumed the standard rate anyway. On a waived escrow
     * that meant addJobFunds and setMilestones CHARGED a fee the client had
     * been told they would not pay, and withdrawJobFunds tried to refund one
     * that was never taken, underflowing and reverting: the client could put
     * money into such a job and never take it out again.
     *
     * Scaling by what the escrow holds is right at both ends. A waived escrow
     * has platformFee 0, so every adjustment is fee-free, for ever. A charged
     * one keeps the ratio it was created with. And a refund can never exceed
     * what was collected, which is what the underflow was really saying.
     */
    function _feeShare(Escrow storage esc, uint256 part) private view returns (uint256) {
        if (esc.platformFee == 0 || esc.totalAmount == 0) return 0;
        return (part * esc.platformFee) / esc.totalAmount;
    }

    function _pushMilestone(uint256 escrowId, uint256 amount, string calldata requirements) private {
        Milestone storage m = escrowMilestones[escrowId].push();
        m.amount = amount;
        m.requirements = requirements;
    }

    function _requireEscrow(uint256 escrowId) private view returns (Escrow storage) {
        Escrow storage esc = escrows[escrowId];
        if (esc.depositor == address(0)) revert EscrowNotFound();
        return esc;
    }

    function _getMilestone(uint256 escrowId, uint256 index) private view returns (Milestone storage) {
        if (index >= escrowMilestones[escrowId].length) revert InvalidMilestone();
        return escrowMilestones[escrowId][index];
    }

    function _removeFromUserEscrows(address user, uint256 escrowId) private {
        uint256[] storage arr = userEscrows[user];
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            if (arr[i] == escrowId) {
                arr[i] = arr[len - 1];
                arr.pop();
                return;
            }
        }
    }

    /**
     * @dev Make sure this contract can pay `amount` of `token` right now.
     *
     * THE CIRCUIT BREAKER. Called before every outbound payment. If cash covers
     * it the controller is never touched, which is what the buffer is for and
     * is the common case.
     *
     * Otherwise it asks the controller to unwind the shortfall. That call is
     * wrapped, and the controller is also written not to revert — belt and
     * braces on purpose, because a venue that reverts, pauses or has gone
     * illiquid must cost us the yield and NOT the payment. Control returns
     * here, the transfer is attempted from whatever cash exists, and a
     * shortfall surfaces as a failed transfer rather than silently short-paying
     * somebody.
     */
    function _ensureLiquid(address token, uint256 amount) private {
        if (address(yieldController) == address(0)) return;

        uint256 cash = token == NATIVE_TOKEN
            ? address(this).balance
            : IERC20(token).balanceOf(address(this));
        if (cash >= amount) return;

        try yieldController.ensureLiquid(token, amount - cash) returns (uint256) {
            // Whatever came back is now in this contract's balance.
        } catch {
            // Survivable. Not paying is not.
        }
    }

    /**
     * @dev Tell the controller an escrow's obligations moved, so the safe
     *      deployment level moved with them. Wrapped for the same reason as
     *      above: this runs after a payment has already gone out.
     */
    function _rebalanceYield(uint256 escrowId) private {
        if (address(yieldController) == address(0)) return;
        try yieldController.onObligationChanged(escrowId) {} catch {}
    }

    /** @dev Transfer out without the liquidity hook — used to fund the venue. */
    function _doTransferRaw(address token, address to, uint256 amount) private {
        if (amount == 0) return;
        if (token == NATIVE_TOKEN) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "ETH transfer failed");
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    function _doTransfer(address token, address from, address to, uint256 amount) private {
        if (amount == 0) return;
        if (from == address(this)) _ensureLiquid(token, amount);
        if (token == NATIVE_TOKEN) {
            if (from == address(this)) {
                (bool ok,) = to.call{value: amount}("");
                require(ok, "ETH transfer failed");
            }
        } else {
            if (from == address(this)) {
                IERC20(token).safeTransfer(to, amount);
            } else {
                IERC20(token).safeTransferFrom(from, to, amount);
            }
        }
    }

    receive() external payable {}

    /**
     * @dev Reserved storage so future versions can add state without shifting
     *      anything that already exists.
     *
     *      When you add a variable, put it directly ABOVE this gap and subtract
     *      the slots you used from the array length — one slot per variable,
     *      except for variables that pack together in a single slot. Get this
     *      wrong and an upgrade silently reinterprets live escrow data as
     *      whatever the new layout says it is; there is no revert, only wrong
     *      numbers.
     */
    /* 50 - 1 for the yieldController pointer above. Get this wrong and the
       next upgrade reinterprets live escrow data as whatever the new layout
       says; there is no revert, only wrong numbers. */
    uint256[49] private __gap;
}
