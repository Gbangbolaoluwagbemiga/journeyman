// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAtelierYield
 * @notice The escrow's entire view of the productive-escrow layer.
 *
 * Deliberately two functions. The escrow calls `ensureLiquid` before it pays
 * anybody and `onObligationChanged` after — everything else about yield is the
 * controller's business, and an escrow holding other people's money should know
 * as little as possible about where that money is being made to work.
 *
 * Keeping this interface small is also what keeps Atelier under EIP-170's
 * 24,576-byte deploy limit, which the combined contract exceeded by 1.6KB.
 */
interface IAtelierYield {
    /**
     * @notice Get `amount` of `token` into the escrow, unwinding if it must.
     * @dev MUST NOT revert. The escrow calls this on the payout path, so a
     *      throw here would let a broken venue block a freelancer being paid —
     *      the exact failure the whole design exists to prevent. Return what
     *      was actually delivered and let the escrow proceed on cash.
     */
    function ensureLiquid(address token, uint256 amount) external returns (uint256 delivered);

    /**
     * @notice Told that an escrow's obligations changed, so the safe level did.
     * @dev Also MUST NOT revert, for the same reason: it is called immediately
     *      after a payment has already been made.
     */
    function onObligationChanged(uint256 escrowId) external;

    /**
     * @notice Did this client say their next job should work? If so, bind it.
     * @dev Answering has to happen inside the creating transaction, because the
     *      answer decides whether a fee is charged and by the next transaction
     *      the money has already moved. An eleventh parameter on createEscrow
     *      would have been the obvious way and cost 1.1KB of ABI decoding on a
     *      contract with 118 bytes to spare, so the client sets a flag on the
     *      controller first and the escrow consumes it here.
     */
    function claimIntent(address client, uint256 escrowId) external returns (bool);
}
