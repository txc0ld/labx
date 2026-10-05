// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ILabxSwapAdapter
/// @notice Abstracts "pay in ETH, settle in USDC" so the membership contract never touches a DEX directly.
interface ILabxSwapAdapter {
    /// @notice Oracle-derived ETH needed for `usdcOut`, before slippage. Reverts on a stale/invalid feed.
    function quoteEthForUsdc(uint256 usdcOut) external view returns (uint256 ethIn);

    /// @notice Swaps the attached ETH for exactly `usdcOut` USDC, sends the USDC to `usdcRecipient`
    ///         and refunds unspent ETH to `refundRecipient`.
    /// @return ethSpent Amount of ETH consumed by the swap.
    function swapEthForExactUsdc(uint256 usdcOut, address usdcRecipient, address refundRecipient)
        external
        payable
        returns (uint256 ethSpent);
}
