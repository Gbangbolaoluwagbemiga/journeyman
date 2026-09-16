// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/Journeyman.sol";
import "../src/yield/JourneymanYield.sol";
import "../src/yield/UniswapV4StableAdapter.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";

/**
 * Put idle escrow capital into a real Uniswap v4 pool on Arbitrum Sepolia.
 *
 *   PROXY_ADDRESS=0x… forge script script/DeployYieldArbitrum.s.sol \
 *     --rpc-url arbitrum_sepolia --broadcast --verify
 *
 * WHY THIS REPLACES DeployYieldTestnet.s.sol
 *
 * That script pointed testnet at {SponsoredVault}, a venue that earns nothing
 * and says so, because Arc had no Uniswap v4 to point at — both canonical
 * PoolManager addresses return empty code there. Arbitrum Sepolia has the real
 * deployment, so the testnet venue and the mainnet venue are now the same
 * contract against the same code, and the only thing separating this deploy
 * from a production one is which chain id it refuses to run on.
 *
 * That matters more than it sounds. Every claim the yield leg makes was, until
 * now, proven on a fork and demonstrated on a stub. This closes the gap.
 */
contract DeployYieldArbitrumScript is Script {
    uint256 internal constant ARBITRUM_SEPOLIA = 421614;

    /// Uniswap v4 PoolManager, Arbitrum Sepolia.
    address constant POOL_MANAGER = 0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317;

    /// Circle's testnet USDC — the token escrows are denominated in.
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    /// The USDT the v4 pools on this chain actually use.
    address constant USDT = 0x382ED578cFBA5A1FfDD83a71CF69a00A6abaA308;

    /// A 0.01% pool with tickSpacing 1 — the usual shape for a stable pair.
    uint24 constant FEE = 100;
    int24 constant TICK_SPACING = 1;

    /*
     * PARITY IS NOT TICK ZERO HERE.
     *
     * On mainnet USDC and USDT are both 6 decimals, so a 1:1 pool starts at tick
     * 0 and sqrtPriceX96 = 2**96. On Arbitrum Sepolia the USDT above carries 18
     * decimals against USDC's 6, and a v4 price is a ratio of RAW units: one
     * dollar of USDT is 1e18 raw, one dollar of USDC is 1e6 raw, so parity is
     * 1e6/1e18 = 1e-12, and sqrt(1e-12) = 1e-6.
     *
     *   sqrtPriceX96 = 2**96 / 1e6 = 79228162514264337593543 (truncated)
     *
     * Getting this wrong does not fail loudly — it opens a pool a million times
     * away from the peg, which is a live invitation to arbitrage funded by our
     * own liquidity.
     */
    uint160 constant SQRT_PRICE_PARITY = 79228162514264337593543;

    /*
     * USDT (0x382e…) sorts below USDC (0x75fa…), so USDC — our asset — is
     * currency1. A position made entirely of currency1 sits entirely BELOW the
     * current price, which is why the band is subtracted rather than added.
     *
     * Ten ticks of clearance, two hundred wide. On a stable pair that is about
     * a tenth of a percent below the peg and two percent deep: far enough that
     * ordinary noise does not drag price into the range and convert principal
     * into the other leg, close enough to earn on the flow that gets there.
     */
    int24 constant RANGE_CLEARANCE = 10;
    int24 constant RANGE_WIDTH = 200;

    function run() external {
        require(block.chainid == ARBITRUM_SEPOLIA, "wrong chain");

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address payable proxy = payable(vm.envAddress("PROXY_ADDRESS"));

        /*
         * REFUSE TO SWAP A CONTROLLER THAT IS STILL HOLDING MONEY.
         *
         * JourneymanYield is not upgradeable, so replacing it means pointing the
         * escrow at a fresh contract — and the outgoing one keeps its
         * `escrowDeployed` book and its position in the venue. The escrow can
         * then only be told about obligations by the NEW controller, which knows
         * nothing of that capital, and the old one can never be triggered again
         * because `onObligationChanged` is onlyEscrow.
         *
         * The result is an escrow holding less cash than it owes, with the
         * difference parked in a vault nothing can reach. That happened once,
         * for 4 USDC, and was repaid out of pocket. It cost nobody but us
         * because the affected escrow was our own; at any real size it would
         * have been a freelancer not getting paid.
         */
        address current = address(Journeyman(proxy).yieldController());
        if (current != address(0)) {
            uint256 stillOut = JourneymanYield(payable(current)).deployedAssets(USDC);
            require(stillOut == 0, "old controller still has capital deployed; unwind it first");
        }

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDT),
            currency1: Currency.wrap(USDC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });

        vm.startBroadcast(pk);

        JourneymanYield controller = new JourneymanYield(proxy);
        Journeyman(proxy).setYieldController(address(controller));

        UniswapV4StableAdapter adapter = new UniswapV4StableAdapter(address(controller), USDC, USDT, POOL_MANAGER);

        /*
         * Open the pool only if nobody has. Pool creation in v4 is
         * permissionless and idempotent from our side: an existing pool is just
         * as real as one we seeded, and more honest, so the starting price below
         * is a fallback rather than an assertion about the market.
         */
        (uint160 existing,,,) = StateLibrary.getSlot0(IPoolManager(POOL_MANAGER), PoolIdLibrary.toId(key));
        if (existing == 0) {
            IPoolManager(POOL_MANAGER).initialize(key, SQRT_PRICE_PARITY);
        }

        (, int24 tick,,) = StateLibrary.getSlot0(IPoolManager(POOL_MANAGER), PoolIdLibrary.toId(key));
        int24 tickUpper = tick - RANGE_CLEARANCE;
        int24 tickLower = tickUpper - RANGE_WIDTH;

        adapter.configurePool(FEE, TICK_SPACING, address(0), tickLower, tickUpper);
        controller.setYieldAdapter(USDC, address(adapter));

        vm.stopBroadcast();

        console.log("JourneymanYield:  ", address(controller));
        console.log("v4 adapter:       ", address(adapter));
        console.log("attached to:      ", proxy);
        console.log("pool manager:     ", POOL_MANAGER);
        console.log("asset:            ", USDC);
        console.log("paired stable:    ", USDT);
        console.log("current tick:     ", tick);
        console.log("range lower:      ", tickLower);
        console.log("range upper:      ", tickUpper);
        console.log("freelancer share: ", controller.freelancerShareBP());
        console.log("buffer bp:        ", controller.yieldBufferBP());
    }
}
