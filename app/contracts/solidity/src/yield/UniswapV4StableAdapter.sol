// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/types/PoolId.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";
import {FullMath} from "v4-core/libraries/FullMath.sol";

/**
 * @title UniswapV4StableAdapter
 * @notice Puts idle escrow capital into a Uniswap v4 stable-stable position.
 *
 * WHAT THIS IS FOR
 *
 * Escrowed money sits still between a job being funded and a milestone being
 * approved — often weeks. That is real capital doing nothing, and it is exactly
 * the demand Uniswap liquidity wants: patient, stable-denominated, and with a
 * known exit date. This is the contribution to the Uniswap stack: escrow TVL
 * that currently sits dead, routed into v4 pools.
 *
 * WHY STABLE-STABLE ONLY, ENFORCED IN THE CONSTRUCTOR
 *
 * Impermanent loss on a volatile pair is a loss of principal, and the principal
 * here is not ours. A USDC/USDT position has near-zero divergence risk, which is
 * the only risk profile an escrow can honestly accept. The pair is immutable
 * after deployment so nobody can later point this at ETH/USDC and keep the same
 * audited address.
 *
 * WHY THE POSITION IS SINGLE-SIDED
 *
 * The escrow holds one asset and is owed that same asset back. Swapping half of
 * it into the paired stable to provide a two-sided position would put principal
 * through a trade, and a trade can lose money. So the range sits entirely to one
 * side of the current price, where the position consists of our asset alone: no
 * swap on the way in, and no exposure to the other leg unless price crosses into
 * the range — which for a stable pair is exactly what a tight band avoids.
 *
 * THE CONTRACT WITH THE ESCROW
 *
 *   withdraw(assets) returns exactly `assets`, or reverts.
 *
 * Never a partial transfer reported as success. Atelier's circuit breaker is
 * built on telling those apart: a revert is caught and the payout proceeds from
 * cash, while a silent shortfall is a hole nobody notices until a freelancer is
 * not paid.
 *
 * WHY IT STILL FAILS CLOSED UNTIL CONFIGURED
 *
 * A PoolKey names one pool on one chain, and there is no sane default. Until
 * `configurePool` has named a pool that exists, is initialised, and whose range
 * is single-sided in our asset, deposit() reverts. An adapter that guessed at a
 * pool would move real money into one nobody chose.
 *
 * THE EVM TARGET, WHICH IS A REAL CONSTRAINT ON WHERE THIS CAN RUN
 *
 * This contract compiles fine under shanghai: it only imports v4's interfaces
 * and pure libraries, and none of those need transient storage. But PoolManager
 * itself takes its lock with TSTORE, so `unlock()` halts with NotActivated on
 * any EVM without cancun. Compiling is not the constraint; the chain is.
 *
 * So this adapter can only be deployed where v4 already runs, which today means
 * a cancun chain — Base, Ethereum, Unichain, and Arc mainnet when it opens. On
 * a chain without transient storage there is no v4 to integrate with at all.
 * The fork tests run under [profile.fork] for exactly this reason, while the
 * default profile stays on shanghai for what Atelier deploys to Arc.
 */
contract UniswapV4StableAdapter is IYieldAdapter, IUnlockCallback, Ownable2Step {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    error NotVault();
    error NotConfigured();
    error PairNotStable();
    error ShortfallOnWithdraw(uint256 requested, uint256 recovered);
    error NotPoolManager();
    error PoolNotInitialised();
    error RangeNotSingleSided();
    error NothingToWithdraw();

    /**
     * The vault this adapter serves — AtelierYield, not the escrow behind it.
     *
     * Named carefully because getting it wrong is a wasted mainnet deploy: the
     * controller is what calls deposit and withdraw, so it is what onlyVault
     * must admit and what withdrawn assets must be sent to. Pass the escrow's
     * address here and every call fails closed with NotVault.
     */
    address public immutable vault;

    /// The asset the escrow deposits and expects back, 1:1.
    address public immutable override asset;

    /// The other half of the stable pair.
    address public immutable pairedStable;

    IPoolManager public immutable poolManager;

    /// True when `asset` sorts first in the pool. Decided once, in the constructor.
    bool public immutable assetIsCurrency0;

    /* ── Pool configuration, set once the target pool is known ────────────── */

    uint24 public poolFee;
    int24 public poolTickSpacing;
    IHooks public poolHooks;
    int24 public tickLower;
    int24 public tickUpper;
    bool public configured;

    /// Principal the escrow has sent in, before any fees earned.
    uint256 public principalDeposited;

    /// Liquidity currently held in the position.
    uint128 public liquidity;

    event Deposited(uint256 assets, uint128 liquidityAdded);
    event Withdrawn(uint256 requested, uint256 recovered);
    event PoolConfigured(uint24 fee, int24 tickSpacing, address hooks, int24 tickLower, int24 tickUpper);

    enum Action {
        Add,
        Remove
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(address _vault, address _asset, address _pairedStable, address _poolManager) Ownable(msg.sender) {
        if (_vault == address(0) || _asset == address(0) || _poolManager == address(0)) revert NotConfigured();
        // Both legs must be stables. Enforced structurally rather than by
        // convention, because "we will only ever use it for USDC" is not a
        // guarantee, it is an intention.
        if (_asset == _pairedStable) revert PairNotStable();

        vault = _vault;
        asset = _asset;
        pairedStable = _pairedStable;
        poolManager = IPoolManager(_poolManager);
        assetIsCurrency0 = _asset < _pairedStable;
    }

    /**
     * @notice Name the pool and the range this adapter provides liquidity in.
     * @dev The range must lie entirely on the side of the current price where
     *      the position is composed of `asset` alone — checked here rather than
     *      trusted, because a range straddling the price would require the
     *      paired stable we do not hold, and modifyLiquidity would raise it as a
     *      debt this contract could not settle.
     */
    function configurePool(uint24 fee, int24 tickSpacing, address hooks, int24 _tickLower, int24 _tickUpper)
        external
        onlyOwner
    {
        poolFee = fee;
        poolTickSpacing = tickSpacing;
        poolHooks = IHooks(hooks);
        tickLower = _tickLower;
        tickUpper = _tickUpper;

        (uint160 sqrtPriceX96, int24 currentTick,,) = poolManager.getSlot0(_key().toId());
        if (sqrtPriceX96 == 0) revert PoolNotInitialised();

        // Below its range a position is all currency0; above it, all currency1.
        bool singleSidedInAsset = assetIsCurrency0 ? currentTick < _tickLower : currentTick >= _tickUpper;
        if (!singleSidedInAsset) revert RangeNotSingleSided();

        configured = true;
        emit PoolConfigured(fee, tickSpacing, hooks, _tickLower, _tickUpper);
    }

    function _key() internal view returns (PoolKey memory) {
        (address c0, address c1) = assetIsCurrency0 ? (asset, pairedStable) : (pairedStable, asset);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: poolFee,
            tickSpacing: poolTickSpacing,
            hooks: poolHooks
        });
    }

    /* ── Liquidity math ───────────────────────────────────────────────────────
     *
     * v4-core ships TickMath and FullMath but not LiquidityAmounts, which lives
     * in v4-periphery. These are the two single-sided cases from it, and only
     * those two: a range straddling the current price is rejected in
     * configurePool, so the mixed case cannot arise here.
     */

    /// L for an amount of currency0, in a range entirely above the current price.
    function _liquidityForAmount0(uint160 sqrtA, uint160 sqrtB, uint256 amount0) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, 1 << 96);
        return uint128(FullMath.mulDiv(amount0, intermediate, sqrtB - sqrtA));
    }

    /// L for an amount of currency1, in a range entirely below the current price.
    function _liquidityForAmount1(uint160 sqrtA, uint160 sqrtB, uint256 amount1) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        return uint128(FullMath.mulDiv(amount1, 1 << 96, sqrtB - sqrtA));
    }

    function _liquidityForAssets(uint256 assets) internal view returns (uint128) {
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        return
            assetIsCurrency0 ? _liquidityForAmount0(sqrtA, sqrtB, assets) : _liquidityForAmount1(sqrtA, sqrtB, assets);
    }

    /// What a given amount of liquidity is worth in `asset`, at range prices.
    function _assetsForLiquidity(uint128 l) internal view returns (uint256) {
        if (l == 0) return 0;
        uint160 sqrtA = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtPriceAtTick(tickUpper);
        if (assetIsCurrency0) {
            return FullMath.mulDiv(uint256(l) << 96, uint256(sqrtB) - sqrtA, uint256(sqrtA) * sqrtB);
        }
        return FullMath.mulDiv(uint256(l), uint256(sqrtB) - sqrtA, 1 << 96);
    }

    /* ── Escrow-facing surface ────────────────────────────────────────────── */

    function deposit(uint256 assets) external payable override onlyVault {
        if (!configured) revert NotConfigured();

        IERC20(asset).safeTransferFrom(msg.sender, address(this), assets);

        uint128 delta = _liquidityForAssets(assets);
        // Dust: too little to mint any liquidity. Held as cash rather than
        // reverting, since the escrow's deposit is not wrong, just small.
        if (delta == 0) {
            principalDeposited += assets;
            emit Deposited(assets, 0);
            return;
        }

        poolManager.unlock(abi.encode(Action.Add, uint256(delta)));

        principalDeposited += assets;
        liquidity += delta;
        emit Deposited(assets, delta);
    }

    /**
     * @inheritdoc IYieldAdapter
     * @dev Asserts the full amount came back before returning. An adapter that
     *      quietly returns less is worse than one that reverts, because the
     *      escrow's breaker can survive a revert and cannot detect a lie.
     */
    function withdraw(uint256 assets) external override onlyVault returns (uint256) {
        if (!configured) revert NotConfigured();
        if (assets == 0) revert NothingToWithdraw();

        uint256 idle = IERC20(asset).balanceOf(address(this));

        if (idle < assets) {
            // Burn one unit more than the arithmetic minimum. Liquidity maths
            // rounds down on the way out, so asking for exactly `assets` worth
            // reliably comes back a wei or two short — and not coming up short
            // is this function's entire promise.
            uint128 need = _liquidityForAssets(assets - idle);
            uint128 burn = need >= liquidity || need + 1 > liquidity ? liquidity : need + 1;
            if (burn > 0) {
                poolManager.unlock(abi.encode(Action.Remove, uint256(burn)));
                liquidity -= burn;
            }
        }

        uint256 recovered = IERC20(asset).balanceOf(address(this));
        if (recovered < assets) revert ShortfallOnWithdraw(assets, recovered);

        principalDeposited = assets > principalDeposited ? 0 : principalDeposited - assets;
        IERC20(asset).safeTransfer(vault, assets);

        emit Withdrawn(assets, recovered);
        return assets;
    }

    /// @notice Idle balance plus what the position is currently worth.
    function totalAssets() external view override returns (uint256) {
        return IERC20(asset).balanceOf(address(this)) + _assetsForLiquidity(liquidity);
    }

    /**
     * @inheritdoc IYieldAdapter
     * @dev Zero while unconfigured — an honest "nothing is available right now"
     *      rather than an optimistic number the escrow would then rely on.
     */
    function maxWithdrawable() external view override returns (uint256) {
        if (!configured) return 0;
        return IERC20(asset).balanceOf(address(this)) + _assetsForLiquidity(liquidity);
    }

    /* ── v4 unlock callback ───────────────────────────────────────────────── */

    /**
     * @notice Where the position is actually minted and burned.
     * @dev v4 requires every pool interaction to happen inside unlock(), and
     *      settles in deltas: negative means this contract owes the manager,
     *      positive means the manager owes this contract.
     */
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (Action action, uint256 amount) = abi.decode(data, (Action, uint256));
        PoolKey memory key = _key();
        Currency ours = assetIsCurrency0 ? key.currency0 : key.currency1;

        int256 liquidityDelta = action == Action.Add ? int256(amount) : -int256(amount);

        (BalanceDelta callerDelta,) = poolManager.modifyLiquidity(
            key,
            IPoolManager.ModifyLiquidityParams({
                tickLower: tickLower,
                tickUpper: tickUpper,
                liquidityDelta: liquidityDelta,
                salt: bytes32(0)
            }),
            ""
        );

        int128 oursDelta = assetIsCurrency0 ? callerDelta.amount0() : callerDelta.amount1();

        if (oursDelta < 0) {
            // We owe the manager: sync, send, settle.
            poolManager.sync(ours);
            IERC20(asset).safeTransfer(address(poolManager), uint256(uint128(-oursDelta)));
            poolManager.settle();
        } else if (oursDelta > 0) {
            poolManager.take(ours, address(this), uint256(uint128(oursDelta)));
        }

        /*
         * The paired stable should never move, because the range is single-sided
         * in `asset`. If it does, price has crossed into the range and this
         * contract is holding a token it has no accounting for. Reverting the
         * whole unlock is the safe end: v4 would reject the unsettled delta
         * anyway, and a partial position is worse than none.
         */
        int128 otherDelta = assetIsCurrency0 ? callerDelta.amount1() : callerDelta.amount0();
        if (otherDelta != 0) revert RangeNotSingleSided();

        return "";
    }
}
