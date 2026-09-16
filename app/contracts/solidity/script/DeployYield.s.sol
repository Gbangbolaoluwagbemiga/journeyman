// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Atelier.sol";
import "../src/yield/AtelierYield.sol";

/**
 * Deploy the productive-escrow controller and attach it to a live Atelier.
 *
 *   PROXY_ADDRESS=0x… forge script script/DeployYield.s.sol \
 *     --rpc-url arc_testnet --broadcast
 *
 * Safe to run against an escrow already holding money: attaching a controller
 * changes nothing until a depositor opts a job in AND a venue is set for its
 * token. Both default to off.
 *
 * No venue is configured here on purpose. Pointing an escrow at a yield venue
 * is a decision about somebody else's capital and should be a separate,
 * deliberate transaction — not a side effect of a deploy script.
 */
contract DeployYieldScript is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address payable proxy = payable(vm.envAddress("PROXY_ADDRESS"));

        vm.startBroadcast(pk);
        AtelierYield controller = new AtelierYield(proxy);
        Atelier(proxy).setYieldController(address(controller));
        vm.stopBroadcast();

        console.log("AtelierYield:", address(controller));
        console.log("attached to:", proxy);
        console.log("buffer bp:", controller.yieldBufferBP());
        console.log("venue set:", address(controller.yieldAdapter(address(0))));
    }
}
