// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxSwapAdapter} from "./interfaces/ILabxSwapAdapter.sol";
import {IUniswapV3SwapRouter} from "./interfaces/IUniswapV3SwapRouter.sol";
import {AggregatorV3Interface} from "./vendor/chainlink/AggregatorV3Interface.sol";

/// @title LabxUniswapV3SwapAdapter
/// @notice Turns an ETH payment into exactly the USDC a membership purchase needs, in one transaction.
/// @dev Uniswap V3 (`SwapRouter02`) performs the exact-output swap. A Chainlink ETH/USD feed is the
///      independent sanity bound: the swap may never consume more ETH than the oracle-implied amount
///      plus `maxSlippageBps`, which is what stops a manipulated pool from draining a buyer's wallet.
contract LabxUniswapV3SwapAdapter is LabxRoles, ReentrancyGuard, ILabxSwapAdapter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    IUniswapV3SwapRouter public immutable router;
    IERC20 public immutable usdc;
    address public immutable weth;
    AggregatorV3Interface public immutable ethUsdFeed;
    uint8 public immutable usdcDecimals;

    /// @notice Uniswap V3 fee tier used for the WETH/USDC hop (500 = 0.05%).
    uint24 public poolFee = 500;
    /// @notice Maximum ETH the swap may consume above the oracle-implied amount.
    uint16 public maxSlippageBps = 300;
    /// @notice Oracle answers older than this are rejected.
    uint64 public maxOracleAge = 3_600;

    event PoolFeeUpdated(uint24 poolFee);
    event MaxSlippageUpdated(uint16 bps);
    event MaxOracleAgeUpdated(uint64 seconds_);
    event EthSwappedForUsdc(
        address indexed caller, uint256 usdcOut, uint256 ethSpent, uint256 ethRefunded, uint256 oracleEthIn
    );

    error StaleOracle(uint256 updatedAt);
    error InvalidOraclePrice(int256 answer);
    error InsufficientEth(uint256 provided, uint256 required);
    error SlippageExceeded(uint256 spent, uint256 ceiling);
    error InvalidSlippage();
    error RefundFailed();
    error NothingToSwap();

    constructor(address admin, address router_, address usdc_, address weth_, address ethUsdFeed_) LabxRoles(admin) {
        if (router_ == address(0) || usdc_ == address(0) || weth_ == address(0) || ethUsdFeed_ == address(0)) {
            revert ZeroAddress();
        }
        router = IUniswapV3SwapRouter(router_);
        usdc = IERC20(usdc_);
        weth = weth_;
        ethUsdFeed = AggregatorV3Interface(ethUsdFeed_);
        usdcDecimals = 6;
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    function setPoolFee(uint24 poolFee_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        poolFee = poolFee_;
        emit PoolFeeUpdated(poolFee_);
    }

    function setMaxSlippageBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > 2_000) revert InvalidSlippage();
        maxSlippageBps = bps;
        emit MaxSlippageUpdated(bps);
    }

    function setMaxOracleAge(uint64 seconds_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxOracleAge = seconds_;
        emit MaxOracleAgeUpdated(seconds_);
    }

    /// @notice Sweeps dust (e.g. a failed refund) to the treasury. Never holds user funds between calls.
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            Address.sendValue(payable(to), amount);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // --------------------------------------------------------------------------------------------
    // Swapping
    // --------------------------------------------------------------------------------------------

    /// @inheritdoc ILabxSwapAdapter
    function quoteEthForUsdc(uint256 usdcOut) public view returns (uint256 ethIn) {
        (, int256 answer,, uint256 updatedAt,) = ethUsdFeed.latestRoundData();
        if (answer <= 0) revert InvalidOraclePrice(answer);
        if (updatedAt == 0 || block.timestamp - updatedAt > maxOracleAge) revert StaleOracle(updatedAt);

        uint8 feedDecimals = ethUsdFeed.decimals();
        // usdcOut (1e6) / (answer / 10**feedDecimals) * 1e18
        ethIn = (usdcOut * (10 ** (uint256(feedDecimals) + 18 - usdcDecimals))) / uint256(answer);
    }

    /// @notice The ETH a caller should attach for `usdcOut`, including the slippage allowance.
    function maxEthForUsdc(uint256 usdcOut) external view returns (uint256) {
        return (quoteEthForUsdc(usdcOut) * (BPS_DENOMINATOR + maxSlippageBps)) / BPS_DENOMINATOR;
    }

    /// @inheritdoc ILabxSwapAdapter
    function swapEthForExactUsdc(uint256 usdcOut, address usdcRecipient, address refundRecipient)
        external
        payable
        nonReentrant
        returns (uint256 ethSpent)
    {
        if (usdcOut == 0) revert NothingToSwap();
        if (usdcRecipient == address(0) || refundRecipient == address(0)) revert ZeroAddress();

        uint256 oracleEthIn = quoteEthForUsdc(usdcOut);
        uint256 ceiling = (oracleEthIn * (BPS_DENOMINATOR + maxSlippageBps)) / BPS_DENOMINATOR;
        if (msg.value < oracleEthIn) revert InsufficientEth(msg.value, oracleEthIn);

        uint256 amountInMaximum = msg.value < ceiling ? msg.value : ceiling;

        ethSpent = router.exactOutputSingle{value: amountInMaximum}(
            IUniswapV3SwapRouter.ExactOutputSingleParams({
                tokenIn: weth,
                tokenOut: address(usdc),
                fee: poolFee,
                recipient: usdcRecipient,
                amountOut: usdcOut,
                amountInMaximum: amountInMaximum,
                sqrtPriceLimitX96: 0
            })
        );
        if (ethSpent > ceiling) revert SlippageExceeded(ethSpent, ceiling);

        // Pull any WETH the router still holds for us back out as ETH before refunding the buyer.
        router.refundETH();

        uint256 refund = msg.value - ethSpent;
        if (refund != 0) {
            (bool ok,) = refundRecipient.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }

        emit EthSwappedForUsdc(msg.sender, usdcOut, ethSpent, refund, oracleEthIn);
    }

    receive() external payable {}
}
