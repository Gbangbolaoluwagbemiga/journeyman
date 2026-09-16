// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../src/yield/IYieldAdapter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * A yield venue that can misbehave in every way a real one can.
 *
 * Testing against a well-behaved mock would prove only that the happy path
 * works, and the happy path is not what the circuit breaker is for. This one
 * can be told to revert on withdrawal, to return less than it was asked for, to
 * go illiquid, or to simply lose money — and the escrow is expected to keep
 * paying people through all of it.
 */
contract MockYieldAdapter is IYieldAdapter {
    address public immutable token;
    address public immutable escrow;

    bool public revertOnWithdraw;
    bool public revertOnDeposit;
    /// Basis points of a withdrawal actually returned. 10000 = honest.
    uint256 public payoutBP = 10000;
    /// Hard ceiling on what can be pulled, whatever the balance says.
    uint256 public liquidCap = type(uint256).max;

    uint256 public principal;

    constructor(address _token, address _escrow) {
        token = _token;
        escrow = _escrow;
    }

    /* ── failure injection ── */
    function setRevertOnWithdraw(bool v) external { revertOnWithdraw = v; }
    function setRevertOnDeposit(bool v) external { revertOnDeposit = v; }
    function setPayoutBP(uint256 v) external { payoutBP = v; }
    function setLiquidCap(uint256 v) external { liquidCap = v; }

    /// Simulate the venue gaining or losing value.
    function simulateYield(int256 delta) external {
        if (delta > 0) {
            principal += uint256(delta);
        } else {
            uint256 loss = uint256(-delta);
            principal = loss > principal ? 0 : principal - loss;
        }
    }

    function asset() external view returns (address) { return token; }

    function deposit(uint256 assets) external payable {
        require(!revertOnDeposit, "MockYieldAdapter: deposit disabled");
        if (token != address(0)) {
            IERC20(token).transferFrom(msg.sender, address(this), assets);
        }
        principal += assets;
    }

    function withdraw(uint256 assets) external returns (uint256) {
        require(!revertOnWithdraw, "MockYieldAdapter: venue unavailable");
        require(assets <= liquidCap, "MockYieldAdapter: illiquid");

        uint256 paid = (assets * payoutBP) / 10000;
        principal = paid > principal ? 0 : principal - paid;

        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: paid}("");
            require(ok, "MockYieldAdapter: native send failed");
        } else {
            IERC20(token).transfer(msg.sender, paid);
        }
        return paid;
    }

    function totalAssets() external view returns (uint256) { return principal; }

    function maxWithdrawable() external view returns (uint256) {
        return principal < liquidCap ? principal : liquidCap;
    }

    receive() external payable {}
}
