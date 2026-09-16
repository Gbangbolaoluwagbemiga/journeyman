// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SponsoredVault
 * @notice A testnet venue that custodies escrow capital and pays a sponsored return.
 *
 * WHAT THIS IS, SAID PLAINLY
 *
 * This is NOT a yield strategy. It trades nothing, lends nothing and earns
 * nothing. It holds the asset, gives it back on demand, and reports a balance
 * that goes up only when somebody deliberately puts more in via `sponsor()`.
 * The "yield" is a gift from the sponsor, and calling it anything else would be
 * a lie told to a freelancer about money they are counting on.
 *
 * WHY IT EXISTS ANYWAY
 *
 * The real venue is {UniswapV4StableAdapter}, and it cannot run here: v4's
 * PoolManager takes its lock with TSTORE, so it needs a cancun chain, and Arc
 * testnet is not one. Without some venue the whole productive-escrow path is
 * unreachable — no escrow ever deploys, `escrowDeployed` is zero on every job,
 * and the 🌱 Earning tag renders for nobody. That is not a demo of a cautious
 * system; it is an untested code path wearing a disclaimer.
 *
 * So this exists to make the mechanism real end to end on testnet — the opt-in,
 * the derived ceiling, the deployment, the unwind on payout, the waterfall that
 * splits what was earned — with the one part that cannot be real clearly
 * labelled as sponsored rather than dressed up as trading fees.
 *
 * WHAT MAKES IT SAFE TO POINT LIVE ESCROW AT
 *
 *   1. Only the vault may move money. `deposit` and `withdraw` are onlyVault,
 *      so no third party can push funds in or pull them out.
 *   2. There is no way out for anyone else, including the owner and the
 *      sponsor. Money sent in is withdrawable ONLY by the vault that deposited
 *      it. A sponsor cannot take back a sponsorship; an owner cannot sweep.
 *      That is deliberate — every "rescue" function is also a rug, and this
 *      contract holds escrow that belongs to freelancers.
 *   3. `withdraw` transfers exactly what was asked or reverts, per
 *      {IYieldAdapter}. It never returns less and reports success, because the
 *      circuit breaker upstream is built on telling those two apart.
 *
 * The consequence of (2) is that unspent sponsorship is stranded here forever.
 * On testnet that is the correct price for having no rug vector at all.
 */
contract SponsoredVault is IYieldAdapter {
    using SafeERC20 for IERC20;

    /// @notice The asset held. address(0) is native, which is USDC on Arc.
    address public immutable token;

    /// @notice The AtelierYield controller. The only address that may move money.
    address public immutable vault;

    error NotVault();
    error WrongAsset();
    error Insufficient();
    error NativeSendFailed();

    event Sponsored(address indexed from, uint256 amount);
    event Deployed(uint256 amount);
    event Returned(uint256 amount);

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    constructor(address _token, address _vault) {
        token = _token;
        vault = _vault;
    }

    /* ─────────────── the sponsorship ─────────────── */

    /**
     * @notice Add to the balance so withdrawals can exceed deposits.
     * @dev Permissionless on purpose: anyone may make this venue pay more, and
     *      nobody — sponsor included — may make it pay less. There is no
     *      matching `unsponsor`, and there must never be one.
     */
    function sponsor(uint256 amount) external payable {
        if (token == address(0)) {
            if (msg.value != amount) revert WrongAsset();
        } else {
            if (msg.value != 0) revert WrongAsset();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }
        emit Sponsored(msg.sender, amount);
    }

    /* ─────────────── the venue interface ─────────────── */

    function asset() external view returns (address) {
        return token;
    }

    function deposit(uint256 assets) external payable onlyVault {
        if (token == address(0)) {
            if (msg.value != assets) revert WrongAsset();
        } else {
            if (msg.value != 0) revert WrongAsset();
            IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
        }
        emit Deployed(assets);
    }

    /**
     * @dev Exactly `assets` back to the vault, or revert. Paying the escrow
     *      directly would leave the vault forwarding money it never received —
     *      the two adapters disagreed about this once, which is why
     *      {IYieldAdapter} now spells it out.
     */
    function withdraw(uint256 assets) external onlyVault returns (uint256) {
        if (assets > _held()) revert Insufficient();

        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: assets}("");
            if (!ok) revert NativeSendFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, assets);
        }

        emit Returned(assets);
        return assets;
    }

    function totalAssets() external view returns (uint256) {
        return _held();
    }

    /**
     * @dev Equal to `totalAssets`: custody has no illiquid moment. A venue that
     *      actually traded would have to answer this with a smaller number
     *      sometimes, and the honest answer there is the smaller one.
     */
    function maxWithdrawable() external view returns (uint256) {
        return _held();
    }

    function _held() internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    /// @dev Accepts native so a sponsor can top it up with a plain transfer.
    receive() external payable {
        emit Sponsored(msg.sender, msg.value);
    }
}
