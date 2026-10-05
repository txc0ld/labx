// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxUniswapV3SwapAdapter} from "../src/LabxUniswapV3SwapAdapter.sol";

/// @notice The Chainlink feed is the independent sanity bound on the Uniswap swap. These tests prove a
///         manipulated or illiquid pool cannot drain a buyer's wallet.
contract LabxSwapAdapterTest is LabxTestBase {
    function test_quoteDerivesEthFromTheOracle() public view {
        // 59 USDC at $3,000/ETH.
        assertEq(swapAdapter.quoteEthForUsdc(59e6), (59e6 * 1e20) / ETH_USD);
        assertEq(swapAdapter.quoteEthForUsdc(3_000e6), 1 ether);
    }

    function test_maxEthIncludesTheSlippageAllowance() public view {
        uint256 oracle = swapAdapter.quoteEthForUsdc(3_000e6);
        assertEq(swapAdapter.maxEthForUsdc(3_000e6), (oracle * 10_300) / 10_000);
    }

    function test_staleOracleIsRejected() public {
        vm.warp(_now() + 10 days);
        uint256 stale = _now() - 3_601;
        ethUsdFeed.setUpdatedAt(stale);

        vm.expectRevert(abi.encodeWithSelector(LabxUniswapV3SwapAdapter.StaleOracle.selector, stale));
        swapAdapter.quoteEthForUsdc(100e6);
    }

    function test_nonPositiveOracleAnswerIsRejected() public {
        ethUsdFeed.setAnswer(0);
        vm.expectRevert(abi.encodeWithSelector(LabxUniswapV3SwapAdapter.InvalidOraclePrice.selector, int256(0)));
        swapAdapter.quoteEthForUsdc(100e6);
    }

    function test_swapRefundsTheUnspentEth() public {
        uint256 target = 100e6;
        uint256 expected = swapAdapter.quoteEthForUsdc(target);
        address recipient = makeAddr("usdc-recipient");

        vm.deal(address(this), 1 ether);
        uint256 before = address(this).balance;
        uint256 spent = swapAdapter.swapEthForExactUsdc{value: 1 ether}(target, recipient, address(this));

        assertEq(spent, expected);
        assertEq(usdc.balanceOf(recipient), target);
        assertEq(before - address(this).balance, expected, "every unspent wei comes back");
    }

    function test_swapRevertsWhenTheAttachedEthIsBelowTheOracleQuote() public {
        uint256 target = 100e6;
        uint256 expected = swapAdapter.quoteEthForUsdc(target);

        vm.deal(address(this), 1 ether);
        vm.expectRevert(
            abi.encodeWithSelector(LabxUniswapV3SwapAdapter.InsufficientEth.selector, expected - 1, expected)
        );
        swapAdapter.swapEthForExactUsdc{value: expected - 1}(target, makeAddr("r4"), address(this));
    }

    function test_poolWorseThanTheOracleBeyondToleranceIsRejected() public {
        // The pool demands 10% more ETH than the oracle implies; the 3% ceiling blocks it.
        router.setExtraSlippageBps(1_000);

        vm.deal(address(this), 10 ether);
        vm.expectRevert(bytes("STF"));
        swapAdapter.swapEthForExactUsdc{value: 10 ether}(100e6, makeAddr("r3"), address(this));
    }

    function test_poolSlightlyWorseThanTheOracleIsAccepted() public {
        router.setExtraSlippageBps(100); // 1%, inside the 3% allowance

        uint256 oracle = swapAdapter.quoteEthForUsdc(100e6);
        vm.deal(address(this), 1 ether);
        uint256 spent = swapAdapter.swapEthForExactUsdc{value: 1 ether}(100e6, makeAddr("r2"), address(this));
        assertEq(spent, (oracle * 10_100) / 10_000);
    }

    function test_membershipPurchaseInheritsTheOracleBound() public {
        router.setExtraSlippageBps(1_000);
        vm.expectRevert(bytes("STF"));
        vm.prank(alice);
        membership.purchaseWithEth{value: 5 ether}(TIER_SILVER, 0);
    }

    function test_slippageToleranceIsAdminOnlyAndCapped() public {
        vm.expectRevert();
        vm.prank(alice);
        swapAdapter.setMaxSlippageBps(500);

        vm.prank(safe);
        swapAdapter.setMaxSlippageBps(500);
        assertEq(swapAdapter.maxSlippageBps(), 500);

        vm.expectRevert(LabxUniswapV3SwapAdapter.InvalidSlippage.selector);
        vm.prank(safe);
        swapAdapter.setMaxSlippageBps(2_001);
    }

    function test_ethPriceMoveChangesTheRequiredEth() public {
        ethUsdFeed.setAnswer(4_000e8);
        router.setUsdcPerEth(4_000e6);

        uint256 total = membership.quoteTierTotal(TIER_SILVER); // 105 USDC
        uint256 expected = (total * 1e20) / 4_000e8;
        assertEq(swapAdapter.quoteEthForUsdc(total), expected);

        uint256 before = alice.balance;
        vm.prank(alice);
        membership.purchaseWithEth{value: 1 ether}(TIER_SILVER, 0);
        assertEq(before - alice.balance, expected);
    }

    receive() external payable {}
}
