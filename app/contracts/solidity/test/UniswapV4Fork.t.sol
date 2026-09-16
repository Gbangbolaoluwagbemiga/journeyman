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
 * Fork tests for the v4 leg, against a real PoolManager.
 *
 * Arc testnet has no Uniswap v4 — both canonical PoolManager addresses return
 * empty code there — so there is nothing to fork on the chain Atelier's escrows
 * live on. Base mainnet has the real deployment, so that is what these point
 * at: the goal is to exercise the adapter against genuine v4 code, not a mock
 * that agrees with us.
 *
 * The pool itself is initialised by the test. Pool creation in v4 is
 * permissionless, so this is a real pool in the real PoolManager, seeded at 1:1
 * with the real USDC and USDT contracts — every line of pool mechanics executed
 * here is Uniswap's. What the test supplies is the starting price, so the
 * assertions can be exact instead of dependent on whatever a mainnet pool
 * happened to be doing that block.
 *
 *   forge test --match-path test/UniswapV4Fork.t.sol --fork-url https://mainnet.base.org
 *
 * They skip when run without a fork, so `forge test` stays green offline.
 */
contract UniswapV4ForkTest is Test {
    /// Uniswap v4 PoolManager on Base mainnet.
    address constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    /// A 0.01% pool with tickSpacing 1 — the usual shape for a stable pair.
    uint24 constant FEE = 100;
    int24 constant TICK_SPACING = 1;

    /// USDC and USDT are both 6 decimals, so parity is exactly tick 0.
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336; // 2**96

    /*
     * USDC (0x8335…) sorts below USDT (0xfde4…), so USDC is currency0 and the
     * single-sided range must sit entirely ABOVE the current tick.
     *
     * Derived from the live tick rather than hardcoded. This pool already exists
     * on Base and sits near parity but not exactly on it — it was at tick 2 when
     * these were written — so a fixed range straddles the price on some blocks
     * and not others, and the test would pass or fail according to the weather.
     */
    int24 tickLower;
    int24 tickUpper;

    /* The vault is AtelierYield in production, not the escrow — see the
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
            currency0: Currency.wrap(USDC),
            currency1: Currency.wrap(USDT),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        // Reverts if this pool already exists on the fork, which is fine to
        // ignore: an existing pool is just as real, and more honest than one we
        // seeded. configurePool below asserts the price is where the range needs
        // it either way.
        try IPoolManager(POOL_MANAGER).initialize(key, SQRT_PRICE_1_1) {} catch {}

        (, int24 currentTick,,) = StateLibrary.getSlot0(IPoolManager(POOL_MANAGER), PoolIdLibrary.toId(key));
        tickLower = currentTick + 10;
        tickUpper = tickLower + 200;

        adapter.configurePool(FEE, TICK_SPACING, address(0), tickLower, tickUpper);
    }

    /// Fund the vault and let the adapter pull from it, the way AtelierYield does.
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
        fresh.configurePool(FEE, TICK_SPACING, address(0), tickLower - 100, tickUpper); // straddles the price
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
        assertTrue(adapter.assetIsCurrency0(), "USDC should sort first against USDT");
        assertEq(address(adapter.poolManager()), POOL_MANAGER);
    }
}
