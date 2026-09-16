// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./JobManagerBase.t.sol";

/**
 * ADJUSTING A JOB WHOSE FEE WAS WAIVED.
 *
 * `createEscrow` waives the platform fee outright for a client who puts their
 * escrow to work: `fee = putToWork ? 0 : (totalAmount * platformFeeBP) / 10000`.
 * Three functions that adjust a funded job then went on using platformFeeBP
 * anyway, and nothing noticed until a real one was edited on testnet.
 *
 * On a waived escrow that meant:
 *
 *   addJobFunds and setMilestones CHARGED a fee the client had been promised
 *   they would not pay
 *
 *   withdrawJobFunds tried to refund a fee that was never collected, and
 *   underflowed — so money could go into such a job and never come out. The
 *   toast said "Funds withdrawn ✓" over a transaction that had reverted.
 *
 * The fix scales the fee by what the escrow actually holds rather than by the
 * platform rate, which is correct at both ends: waived stays waived for ever,
 * charged keeps its ratio, and a refund can never exceed what was collected.
 */
contract WaivedFeeAdjustmentsTest is JobManagerBase {
    function test_aWaivedEscrowIsNotChargedWhenStagesAreAdded() public {
        uint256 id = _createOpenJob();
        _waiveFee(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = M1; amounts[1] = M2; amounts[2] = 100e6;
        string[] memory reqs = new string[](3);
        reqs[0] = "a"; reqs[1] = "b"; reqs[2] = "c";
        sf.setMilestones(id, amounts, reqs);

        // 100 for the work and NOT a cent of fee.
        assertEq(before - usdc.balanceOf(client), 100e6, "no fee on a waived escrow");
    }

    function test_aWaivedEscrowCanStillHaveFundsWithdrawn() public {
        // The reported failure: withdrawJobFunds underflowed on platformFee,
        // so a waived job was a one-way door for the client's money.
        uint256 id = _createOpenJob();
        _waiveFee(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.withdrawJobFunds(id, 100e6, 0);

        assertEq(usdc.balanceOf(client) - before, 100e6, "principal back, no phantom fee");
        assertEq(sf.getEscrow(id).totalAmount, BUDGET - 100e6);
    }

    function test_aWaivedEscrowIsNotChargedByAddJobFunds() public {
        uint256 id = _createOpenJob();
        _waiveFee(id);

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.addJobFunds(id, 50e6, 0);

        assertEq(before - usdc.balanceOf(client), 50e6, "no fee on a waived escrow");
    }

    /* ─────────────── A charged escrow keeps charging ─────────────── */

    function test_aChargedEscrowStillPaysItsRateOnAnIncrease() public {
        uint256 id = _createOpenJob(); // fee charged at 2.5% of 900

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.addJobFunds(id, 100e6, 0);

        // 100 plus 2.5 — the ratio the escrow was created with, preserved.
        assertEq(before - usdc.balanceOf(client), 102_500_000);
    }

    function test_aChargedEscrowIsRefundedItsRateOnAWithdrawal() public {
        uint256 id = _createOpenJob();

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.withdrawJobFunds(id, 100e6, 0);

        assertEq(usdc.balanceOf(client) - before, 102_500_000);
    }

    function test_theFeeNeverRefundsMoreThanWasCollected() public {
        // What the underflow was really saying. Take the whole job back out and
        // the fee returned must be exactly the fee that went in, never more.
        uint256 id = _createOpenJob();
        uint256 feeCharged = sf.getEscrow(id).platformFee;

        uint256 before = usdc.balanceOf(client);
        vm.prank(client);
        sf.withdrawJobFunds(id, M1, 0);
        vm.prank(client);
        sf.withdrawJobFunds(id, M2, 1);

        assertEq(usdc.balanceOf(client) - before, BUDGET + feeCharged, "principal and its fee, exactly");
        assertEq(sf.getEscrow(id).platformFee, 0);
    }

    /**
     * @dev Drive platformFee to zero the way the waiver does at creation.
     *      Written against storage because the fixture deploys no yield
     *      controller, and the property under test is "platformFee is 0", not
     *      how it got there.
     */
    function _waiveFee(uint256 id) internal {
        bytes32 base = keccak256(abi.encode(id, uint256(3)));
        // Escrow layout: depositor, beneficiary, token, totalAmount, paidAmount,
        // deadline, status/workStarted packed, platformFee ...
        for (uint256 slot; slot < 16; ++slot) {
            bytes32 loc = bytes32(uint256(base) + slot);
            if (uint256(vm.load(address(sf), loc)) == sf.getEscrow(id).platformFee
                && sf.getEscrow(id).platformFee != 0) {
                vm.store(address(sf), loc, bytes32(0));
                break;
            }
        }
        assertEq(sf.getEscrow(id).platformFee, 0, "fee waived for the test");
    }
}
