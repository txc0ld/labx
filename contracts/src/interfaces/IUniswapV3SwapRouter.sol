// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The `SwapRouter02` surface LABx uses (exact-output single hop + ETH refund).
/// @dev Hand-written rather than importing `@uniswap/v3-periphery`, which pins an older solc.
interface IUniswapV3SwapRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn);

    function refundETH() external payable;
}
