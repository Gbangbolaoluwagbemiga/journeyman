// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/yield/UniswapV4StableAdapter.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";

/**
 * Fork tests for the v4 leg, against the PoolManager Journeyman is deployed on.
 *
 * These used to fork Base, because the previous chain had no Uniswap v4 — both
 * canonical PoolManager addresses return empty code there — so the adapter could
 * only ever be exercised somewhere it would never run. Arbitrum Sepolia has a
 * live PoolManager and Journeyman's yield venue is deployed against it, so these
 * now fork the same chain, the same manager and the same pair as production.
 *
 * That closes a gap worth naming. The two things this pair gets wrong on any
 * other chain are decimals and sort order, and both are silent:
 *
 *   • Parity is not tick 0 here. Mainnet USDC and USDT are both 6 decimals; the
 *     USDT the v4 pools on this chain use carries 18 against USDC's 6, and a v4
 *     price is a ratio of RAW units, so parity is 1e6/1e18 and sqrtPriceX96 is
 *     2**96/1e6. A test that assumed tick 0 would seed a pool a million times
 *     off the peg and still pass.
 *
 *   • USDC sorts BELOW USDT on mainnet and ABOVE it here, so our asset is
 *     currency1 rather than currency0 — which flips which side of the current
 *     price a single-sided position has to sit on.
 *
 * Pool creation in v4 is permissionless, so the pool below is a real pool in the
 * real PoolManager and every line of pool mechanics executed here is Uniswap's.
 *
 *   forge test --match-path test/UniswapV4Fork.t.sol \
 *     --fork-url https://sepolia-rollup.arbitrum.io/rpc
 *
 * They skip when run without a fork, so `forge test` stays green offline.
 */
contract UniswapV4ForkTest is Test {
    /// Uniswap v4 PoolManager on Arbitrum Sepolia — the one production uses.
    address constant POOL_MANAGER = 0xFB3e0C6F74eB1a21CC1Da29aeC80D2Dfe6C9a317;
    address constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;
    address constant USDT = 0x382ED578cFBA5A1FfDD83a71CF69a00A6abaA308;

    /// A 0.01% pool with tickSpacing 1 — the usual shape for a stable pair.
    uint24 constant FEE = 100;
    int24 constant TICK_SPACING = 1;

    /// sqrt(1e6/1e18) << 96 — parity for 18-decimal USDT against 6-decimal USDC.
    uint160 constant SQRT_PRICE_PARITY = 79228162514264337593543; // 2**96 / 1e6

    /*
     * USDT (0x382e…) sorts below USDC (0x75fa…), so USDC — the asset — is
     * currency1, and a position made entirely of it sits entirely BELOW the
     * current tick.
     *
     * Derived from the live tick rather than hardcoded, because a pool drifts.
     * A fixed range straddles the price on some blocks and not others, and the
     * test would then pass or fail according to the weather.
     */
    int24 tickLower;
    int24 tickUpper;

    /* The vault is JourneymanYield in production, not the escrow — see the
       adapter's `vault` field. Named accordingly here so the test does not
       teach the wrong thing. */
    address vault = makeAddr("vault");
    UniswapV4StableAdapter adapter;

    function _onFork() internal view returns (bool) {
        return POOL_MANAGER.code.length > 0;
    }

    function setUp() public {
        if (!_onFork()) return;

        adapter = new UniswapV4StableAdapter(vault, USDC, USDT, POOL_MANAGER);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(USDT),
            currency1: Currency.wrap(USDC),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        // Reverts if this pool already exists on the fork, which it does — the
        // deploy script opened it. Fine to ignore either way: an existing pool
        // is just as real, and more honest than one we seeded. configurePool
        // below asserts the price is where the range needs it regardless.
        try IPoolManager(POOL_MANAGER).initialize(key, SQRT_PRICE_PARITY) {} catch {}

        (, int24 currentTick,,) = StateLibrary.getSlot0(IPoolManager(POOL_MANAGER), PoolIdLibrary.toId(key));
        tickUpper = currentTick - 10;
        tickLower = tickUpper - 200;

        adapter.configurePool(FEE, TICK_SPACING, address(0), tickLower, tickUpper);
    }

    /// Fund the vault and let the adapter pull from it, the way JourneymanYield does.
    function _fundVault(uint256 amount) internal {
        deal(USDC, vault, amount);
        vm.prank(vault);
        IERC20(USDC).approve(address(adapter), type(uint256).max);
    }

    /**
     * Proves the fork is real before anything is concluded from it. Without
     * this, every test below would "pass" against an empty chain by skipping,
     * and a broken --fork-url would look like a clean run.
     */
    function test_fork_poolManagerIsDeployed() public {
        if (!_onFork()) {
            emit log("SKIP: no fork configured - pass --fork-url to run these");
            return;
        }
        assertGt(POOL_MANAGER.code.length, 0, "PoolManager has no code on this fork");
        assertGt(USDC.code.length, 0, "USDC has no code on this fork");
        assertTrue(adapter.configured(), "pool was not configured against the real manager");
    }

    /// The headline: real liquidity minted in a real PoolManager.
    function test_fork_depositMintsLiquidityInThePool() public {
        if (!_onFork()) return;
        _fundVault(1_000e6);

        vm.prank(vault);
        adapter.deposit(1_000e6);

        assertGt(adapter.liquidity(), 0, "no liquidity was minted");
        assertEq(adapter.principalDeposited(), 1_000e6, "principal not recorded");
        // The assets left this contract for the pool rather than sitting idle.
        assertLt(IERC20(USDC).balanceOf(address(adapter)), 1_000e6, "assets never reached the pool");
        assertApproxEqRel(adapter.totalAssets(), 1_000e6, 0.01e18, "position is not worth what went in");
    }

    /// And the round trip: the escrow gets its money back, to the wei.
    function test_fork_withdrawReturnsExactlyWhatWasAsked() public {
        if (!_onFork()) return;
        _fundVault(1_000e6);

        vm.prank(vault);
        adapter.deposit(1_000e6);

        uint256 vaultBefore = IERC20(USDC).balanceOf(vault);

        vm.prank(vault);
        uint256 got = adapter.withdraw(400e6);

        assertEq(got, 400e6, "withdraw did not return the amount it claimed");
        assertEq(IERC20(USDC).balanceOf(vault) - vaultBefore, 400e6, "vault was not paid exactly");
        assertLt(adapter.liquidity(), type(uint128).max, "liquidity accounting broke");
    }

    /// The whole position can be unwound, not just a slice of it.
    function test_fork_canWithdrawEverythingItAccountsFor() public {
        if (!_onFork()) return;
        _fundVault(1_000e6);

        vm.prank(vault);
        adapter.deposit(1_000e6);

        // Rounding on the way in and out means the recoverable amount is a hair
        // under what went in; asking for that figure must succeed exactly.
        uint256 available = adapter.maxWithdrawable();
        assertGt(available, 990e6, "lost more than rounding to the pool");

        vm.prank(vault);
        uint256 got = adapter.withdraw(available > 1_000e6 ? 1_000e6 : available);
        assertGt(got, 990e6, "could not unwind the position");
    }

    /// A shortfall must revert rather than quietly under-pay.
    function test_fork_withdrawRevertsRatherThanUnderPaying() public {
        if (!_onFork()) return;
        _fundVault(100e6);

        vm.prank(vault);
        adapter.deposit(100e6);

        vm.prank(vault);
        vm.expectRevert();
        adapter.withdraw(10_000e6); // far more than the position holds
    }

    /// Only the escrow may drive the adapter.
    function test_fork_depositRejectsAnyOtherCaller() public {
        if (!_onFork()) return;

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(UniswapV4StableAdapter.NotVault.selector);
        adapter.deposit(1_000e6);
    }

    /// Only the PoolManager may invoke the callback that moves funds.
    function test_fork_unlockCallbackRejectsAnyOtherCaller() public {
        if (!_onFork()) return;

        vm.prank(makeAddr("stranger"));
        vm.expectRevert(UniswapV4StableAdapter.NotPoolManager.selector);
        adapter.unlockCallback(abi.encode(UniswapV4StableAdapter.Action.Remove, uint256(1)));
    }

    /// A range straddling the price would need the stable we do not hold.
    function test_fork_rejectsARangeThatIsNotSingleSided() public {
        if (!_onFork()) return;

        UniswapV4StableAdapter fresh = new UniswapV4StableAdapter(vault, USDC, USDT, POOL_MANAGER);
        vm.expectRevert(UniswapV4StableAdapter.RangeNotSingleSided.selector);
        fresh.configurePool(FEE, TICK_SPACING, address(0), tickLower, tickUpper + 100); // straddles the price
    }

    /// An unconfigured adapter reports nothing available and refuses deposits.
    function test_fork_failsClosedBeforeConfiguration() public {
        if (!_onFork()) return;

        UniswapV4StableAdapter fresh = new UniswapV4StableAdapter(vault, USDC, USDT, POOL_MANAGER);
        assertEq(fresh.maxWithdrawable(), 0, "claimed liquidity before being configured");

        vm.prank(vault);
        vm.expectRevert(UniswapV4StableAdapter.NotConfigured.selector);
        fresh.deposit(1_000e6);
    }

    /// The constructor's stable-pair rule holds against real token addresses.
    function test_fork_rejectsAPairThatIsNotTwoDistinctTokens() public {
        if (!_onFork()) return;
        vm.expectRevert(UniswapV4StableAdapter.PairNotStable.selector);
        new UniswapV4StableAdapter(vault, USDC, USDC, POOL_MANAGER);
    }

    /// The pair is fixed at construction so an audited address cannot be repointed.
    function test_fork_pairIsImmutable() public view {
        if (!_onFork()) return;
        assertEq(adapter.asset(), USDC);
        assertEq(adapter.pairedStable(), USDT);
        assertFalse(adapter.assetIsCurrency0(), "USDC sorts second against this chain's USDT");
        assertEq(address(adapter.poolManager()), POOL_MANAGER);
    }
}
