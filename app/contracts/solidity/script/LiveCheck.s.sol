// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Journeyman.sol";
import "../src/yield/JourneymanYield.sol";
import "../src/yield/UniswapV4StableAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * One real job, all the way through, against the live deployment.
 *
 *   PROXY_ADDRESS=0x… forge script script/LiveCheck.s.sol \
 *     --rpc-url arbitrum_sepolia --broadcast
 *
 * WHY THIS EXISTS AND WHY IT SPENDS REAL (TESTNET) MONEY
 *
 * 974 tests pass and all of them run against a contract this script's author
 * deployed in the same process. That proves the logic and proves nothing about
 * the DEPLOYMENT: whether USDC is whitelisted, whether an arbiter exists,
 * whether the yield controller is wired, whether the adapter's pool is
 * configured, whether the token the frontend points at is the token the
 * escrow accepts.
 *
 * Every one of those is a piece of state on a live chain rather than a line of
 * code, none of them fail at deploy time, and two of them were in fact wrong
 * for a day after this contract went up. So: hire somebody, put the money to
 * work, deliver, get paid, and assert the numbers at each step.
 *
 * It is idempotent in the sense that matters — it creates a NEW escrow every
 * run and never touches an existing one.
 */
contract LiveCheckScript is Script {
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    /// 4 USDC across two stages, which is a plausible small job and cheap to redo.
    uint256 constant BUDGET = 4_000_000;
    uint256 constant STAGE = 2_000_000;

    function run() external {
        require(block.chainid == ARBITRUM_SEPOLIA, "wrong chain");

        uint256 clientPk = vm.envUint("PRIVATE_KEY");
        uint256 freelancerPk = vm.envUint("E2E_FREELANCER_KEY");
        address payable proxy = payable(vm.envAddress("PROXY_ADDRESS"));

        address client = vm.addr(clientPk);
        address freelancer = vm.addr(freelancerPk);

        Journeyman esc = Journeyman(proxy);
        JourneymanYield ctrl = JourneymanYield(payable(address(esc.yieldController())));

        console.log("client      ", client);
        console.log("freelancer  ", freelancer);
        console.log("controller  ", address(ctrl));

        (uint256 deposit, uint256 fee) = esc.quoteDeposit(BUDGET);
        console.log("deposit     ", deposit);
        console.log("fee         ", fee);
        require(IERC20(USDC).balanceOf(client) >= deposit, "client has no USDC");

        uint256 freelancerBefore = IERC20(USDC).balanceOf(freelancer);

        /* ── 1. Fund the job ──────────────────────────────────────────────── */
        vm.startBroadcast(clientPk);
        IERC20(USDC).approve(proxy, deposit);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = STAGE;
        amounts[1] = STAGE;
        string[] memory descs = new string[](2);
        descs[0] = "Stage 1 - concepts";
        descs[1] = "Stage 2 - final files";
        address[] memory arbiters = new address[](0);

        uint256 id = esc.createEscrow(
            freelancer,
            USDC,
            BUDGET,
            14,
            arbiters,
            0,
            amounts,
            descs,
            "Live check - logo",
            "A real escrow, funded to prove the deployment works end to end."
        );
        console.log("escrow id   ", id);

        ctrl.setYieldOptIn(id, true);
        vm.stopBroadcast();

        /* ── 2. The freelancer starts ─────────────────────────────────────── */
        /*
         * BEFORE THE YIELD LEG, NOT AFTER, AND THE ORDER IS THE POINT.
         *
         * investableCeiling returns 0 until `workStarted`, because for exactly
         * as long as the client can still cancel and take everything back, all
         * of it has to be sitting there to be taken. The first draft of this
         * script invested before startWork, got a ceiling of 0, and would have
         * reported the whole yield path as working while deploying nothing.
         */
        vm.startBroadcast(freelancerPk);
        esc.startWork(id);
        vm.stopBroadcast();

        /* ── 3. Put the genuinely idle money to work in the v4 pool ───────── */
        console.log("ceiling     ", ctrl.investableCeiling(id));
        console.log("investable  ", ctrl.investableAmount(id));

        vm.startBroadcast(clientPk);
        ctrl.investIdle(id);
        vm.stopBroadcast();

        console.log("deployed    ", ctrl.deployedAssets(USDC));
        require(ctrl.deployedAssets(USDC) > 0, "nothing reached the pool");

        /* ── 4. Deliver ───────────────────────────────────────────────────── */
        vm.startBroadcast(freelancerPk);
        esc.submitMilestone(id, 0, "Three concepts, SVG + PNG. https://example.com/concepts");
        vm.stopBroadcast();

        /* ── 5. The client approves, which unwinds what it has to ─────────── */
        vm.startBroadcast(clientPk);
        esc.approveMilestone(id, 0);
        vm.stopBroadcast();

        console.log("paid stage 1", IERC20(USDC).balanceOf(freelancer) - freelancerBefore);
        /*
         * Still deployed, and correctly so: the reserve is the largest UNPAID
         * milestone plus the buffer, and there was enough cash to settle stage
         * one without touching the position. Unwinding capital that did not
         * need to move is a trade nobody asked for.
         */
        console.log("still deployed", ctrl.deployedAssets(USDC));
        console.log("  this escrow", ctrl.escrowDeployed(id));
        console.log("  adapter has", UniswapV4StableAdapter(payable(address(ctrl.yieldAdapter(USDC)))).totalAssets());

        /* ── 6. The last stage, which cannot be paid without unwinding ────── */
        vm.startBroadcast(freelancerPk);
        esc.submitMilestone(id, 1, "Final files, all formats. https://example.com/final");
        vm.stopBroadcast();

        vm.startBroadcast(clientPk);
        esc.approveMilestone(id, 1);
        vm.stopBroadcast();

        uint256 paid = IERC20(USDC).balanceOf(freelancer) - freelancerBefore;
        console.log("paid in total", paid);
        console.log("left deployed", ctrl.deployedAssets(USDC));
        console.log("  this escrow", ctrl.escrowDeployed(id));
        console.log("  adapter has", UniswapV4StableAdapter(payable(address(ctrl.yieldAdapter(USDC)))).totalAssets());
        console.log("  banked yield", ctrl.escrowYield(id));

        require(paid >= BUDGET, "freelancer was underpaid");
        /*
         * One unit, not the whole position.
         *
         * Minting a v4 position rounds the liquidity down, so a deposit is
         * worth one unit less the instant it lands and the venue can never
         * return quite its own principal. That unit stays on the books as an
         * honest "we cannot reach this" — writing it off would be the same
         * gesture as writing off a venue that had actually lost money, and a
         * fuzzed invariant rejects that within a few thousand calls.
         *
         * Before the controller learned to ask for what the venue HAS rather
         * than what the book SAYS, this number was the entire 1.6 USDC: the
         * adapter reverted rather than underpay, the catch swallowed it, and
         * the position could never be closed at all.
         */
        require(ctrl.deployedAssets(USDC) <= 1, "capital stranded in the venue");
    }
}
