// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IUniswapV3SwapRouter} from "../../src/interfaces/IUniswapV3SwapRouter.sol";

/// @notice Test double for Uniswap's `SwapRouter02`, exact-output single hop paid in ETH.
/// @dev `usdcPerEth` is the pool's effective price (USDC 6dp per 1e18 wei). `extraSlippageBps` lets a test
///      make the pool quote worse than the Chainlink feed, which is how the oracle sanity bound is proven.
contract MockSwapRouter is IUniswapV3SwapRouter {
    IERC20 public immutable usdc;
    uint256 public usdcPerEth;
    uint16 public extraSlippageBps;

    mapping(address payer => uint256) public pendingRefund;

    constructor(address usdc_, uint256 usdcPerEth_) {
        usdc = IERC20(usdc_);
        usdcPerEth = usdcPerEth_;
    }

    function setUsdcPerEth(uint256 value) external {
        usdcPerEth = value;
    }

    function setExtraSlippageBps(uint16 bps) external {
        extraSlippageBps = bps;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn) {
        amountIn = (params.amountOut * 1e18) / usdcPerEth;
        amountIn = (amountIn * (10_000 + extraSlippageBps)) / 10_000;

        require(amountIn <= params.amountInMaximum, "STF");
        require(msg.value >= amountIn, "insufficient eth");

        pendingRefund[msg.sender] += msg.value - amountIn;
        require(usdc.transfer(params.recipient, params.amountOut), "usdc transfer failed");
    }

    function refundETH() external payable {
        uint256 amount = pendingRefund[msg.sender];
        if (amount == 0) return;
        pendingRefund[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "refund failed");
    }

    receive() external payable {}
}
