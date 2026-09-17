// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Journeyman.sol";

/**
 * Whitelist USDC on a deployment.
 *
 *   JOURNEYMAN_ADDRESS=<PROXY> forge script script/WhitelistUSDC.s.sol \
 *     --rpc-url arbitrum_sepolia --broadcast
 *
 * Without this, createEscrow reverts with TokenNotWhitelisted for every job —
 * so it is the difference between a deployed contract and a usable one.
 *
 * The address used to be hardcoded to the pre-ETHOnline deployment, which meant
 * running this after a redeploy quietly configured the OLD contract and left the
 * new one unusable, with a successful-looking transaction to prove it. It reads
 * the target from the environment now.
 */
contract WhitelistUSDCScript is Script {
    /*
     * Circle's testnet USDC on Arbitrum Sepolia — the ERC20 the frontend points
     * at, and the only token escrows are denominated in.
     *
     * This used to be Arc's USDC precompile at 0x3600…0000, where address(0)
     * also meant USDC because it was the chain's native currency. Neither is
     * true here: address(0) is ETH, which is gas and not money anybody is owed,
     * so the whitelist has to name the ERC20 explicitly.
     */
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        /*
         * JOURNEYMAN_ADDRESS, with the pre-rename name still accepted.
         *
         * A deploy script that suddenly cannot find its address is a bad way to
         * discover a rename — this one runs rarely, from a shell whose history
         * still has the old spelling in it.
         *
         * Written as two envOr calls rather than one with a fallback argument.
         * Solidity evaluates arguments eagerly, so `envOr(A, envAddress(B))`
         * calls envAddress(B) FIRST and reverts there when B is unset — which
         * means the fallback this comment describes never once worked, and the
         * script failed with "SECUREFLOW_ADDRESS not found" while the correct
         * variable sat right there in the environment.
         */
        address fromNewName = vm.envOr("JOURNEYMAN_ADDRESS", address(0));
        address payable journeymanAddress =
            payable(fromNewName != address(0) ? fromNewName : vm.envAddress("SECUREFLOW_ADDRESS"));

        vm.startBroadcast(deployerPrivateKey);
        Journeyman(journeymanAddress).whitelistToken(USDC);
        vm.stopBroadcast();

        console.log("contract:", journeymanAddress);
        console.log("USDC whitelisted:", USDC);
    }
}
