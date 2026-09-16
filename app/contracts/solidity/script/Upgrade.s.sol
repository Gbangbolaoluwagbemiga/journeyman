// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Atelier.sol";

/**
 * Ships a new implementation to an existing proxy.
 *
 *   PROXY_ADDRESS=0x… forge script script/Upgrade.s.sol \
 *     --rpc-url arc_testnet --broadcast
 *
 * BEFORE RUNNING THIS:
 *
 *   1. `forge test --match-path test/AtelierUpgrade.t.sol` must pass. Those
 *      tests upgrade a proxy holding a live, mid-flight escrow and assert that
 *      every field survives — which is the failure this script can cause and
 *      cannot undo.
 *   2. Confirm the storage rules at the top of Atelier.sol were followed:
 *      new variables appended above __gap, gap length reduced to match, nothing
 *      reordered or retyped.
 *   3. Bump version() so the deployed build is identifiable from chain state.
 *
 * A bad upgrade does not revert. It reinterprets live escrow storage under the
 * new layout and keeps going, with wrong numbers and real money behind them.
 */
contract UpgradeScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address proxyAddress = vm.envAddress("PROXY_ADDRESS");

        Atelier proxy = Atelier(payable(proxyAddress));
        string memory before = proxy.version();
        uint256 escrowsBefore = proxy.nextEscrowId();

        vm.startBroadcast(deployerPrivateKey);

        Atelier newImplementation = new Atelier();
        proxy.upgradeToAndCall(address(newImplementation), "");

        vm.stopBroadcast();

        console.log("proxy:", proxyAddress);
        console.log("new implementation:", address(newImplementation));
        console.log("version before:", before);
        console.log("version after:", proxy.version());

        // A cheap canary: nextEscrowId is the one counter that must never move
        // during an upgrade. If it did, the layout shifted.
        require(proxy.nextEscrowId() == escrowsBefore, "STORAGE SHIFTED - DO NOT USE THIS PROXY");
        console.log("escrow counter intact:", escrowsBefore);
    }
}
