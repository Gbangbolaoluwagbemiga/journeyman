// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Journeyman.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * Put one real open job on the board.
 *
 *   PROXY_ADDRESS=0x… forge script script/SeedOpenJob.s.sol \
 *     --rpc-url arbitrum_sepolia --broadcast
 *
 * An open job is `beneficiary == address(0)`: nobody is hired, anybody may
 * apply, and the client picks. That is the path LiveCheck.s.sol does NOT
 * exercise — it names its freelancer up front — so it is also the path the
 * board, the application flow and the agent's hiring loop all depend on and
 * nothing had yet tried against the live contract.
 *
 * Costs the budget plus the platform fee, in testnet USDC.
 */
contract SeedOpenJobScript is Script {
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external {
        require(block.chainid == ARBITRUM_SEPOLIA, "wrong chain");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address payable proxy = payable(vm.envAddress("PROXY_ADDRESS"));
        uint256 budget = vm.envOr("BUDGET", uint256(3_000_000));

        Journeyman esc = Journeyman(proxy);
        (uint256 deposit, uint256 fee) = esc.quoteDeposit(budget);
        require(IERC20(USDC).balanceOf(vm.addr(pk)) >= deposit, "not enough USDC");

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = budget / 3;
        amounts[1] = budget - amounts[0];
        string[] memory descs = new string[](2);
        descs[0] = "Wireframes and one round of revisions";
        descs[1] = "Final responsive build, handed over in a repo";
        address[] memory arbiters = new address[](0);

        vm.startBroadcast(pk);
        IERC20(USDC).approve(proxy, deposit);
        uint256 id = esc.createEscrow(
            address(0), // open: nobody is hired yet
            USDC,
            budget,
            14,
            arbiters,
            0,
            amounts,
            descs,
            "Landing page for a small roastery",
            "One page, mobile first. Copy is written; needs layout, build and handover. Apply with something you have shipped."
        );
        vm.stopBroadcast();

        console.log("open job  ", id);
        console.log("budget    ", budget);
        console.log("fee       ", fee);
        console.log("deposited ", deposit);
    }
}
