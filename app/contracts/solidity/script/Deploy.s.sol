// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Atelier.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/**
 * Deploys Atelier behind an ERC1967 proxy.
 *
 * THE ADDRESS THAT MATTERS IS THE PROXY. Everything — the frontend, the Patron
 * daemon, the subgraph, the block explorer link in every job — points at the
 * proxy and never at the implementation. The implementation address changes on
 * every upgrade; the proxy address is the contract, forever.
 *
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast
 *
 * To upgrade later, use Upgrade.s.sol. Do not run this script again — it would
 * deploy a second, empty escrow contract at a new address and strand every live
 * escrow at the old one.
 */
contract DeployScript is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        address feeCollector = vm.addr(deployerPrivateKey);
        uint256 platformFeeBP = 250; // 2.5%

        Atelier implementation = new Atelier();

        // initialize runs through the proxy, in the proxy's storage. Passing it
        // as constructor data makes deploy-and-initialise a single transaction,
        // so there is no window in which an unowned proxy sits on-chain waiting
        // for someone else to call initialize first.
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(implementation),
            abi.encodeCall(Atelier.initialize, (feeCollector, platformFeeBP))
        );

        console.log("Atelier implementation:", address(implementation));
        console.log("Atelier PROXY (use this one):", address(proxy));
        console.log("version:", Atelier(payable(address(proxy))).version());

        vm.stopBroadcast();
    }
}
