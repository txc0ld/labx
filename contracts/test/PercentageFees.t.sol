// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdmissionFixture} from "./AdmissionFixture.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockFeed, MockWETH, MockRouter, MockVRF} from "./mocks/Mocks.sol";

contract FeeBatchBuyer {
    function buyTwice(LabxRaffle raffle, MockERC20 token, uint256 id, bytes32 terms) external {
        token.approve(address(raffle), 55e6);
        raffle.buyPack(id, 0, 1, terms);
        raffle.buyPack(id, 0, 1, terms);
    }
}

abstract contract PercentageFeeFixture is AdmissionFixture {
    LabxRaffle internal raffle;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockVRF internal vrf;
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal cara = makeAddr("cara");
    address internal treasury = makeAddr("treasury");
    bytes32 internal constant TERMS = keccak256("percentage-fee-test-terms");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrf = new MockVRF();
        MockWETH weth = new MockWETH();
        MockRouter router = new MockRouter(weth, usdc);
        MockFeed feed = new MockFeed();
        raffle = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(feed),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: keccak256("key"),
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
    }

    function _open(uint128 price) internal returns (uint256 id) {
        uint256 tokenId = raffle.nextId();
        nft.mint(seller, tokenId);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](2);
        packs[0] = LabxRaffle.PackConfig("First", price, 1, 1000);
        packs[1] = LabxRaffle.PackConfig("Second", 51, 1, 1000);
        vm.startPrank(seller);
        id = raffle.createRaffle(
            address(nft),
            tokenId,
            uint64(vm.getBlockTimestamp() + 1 days),
            keccak256("nonce"),
            keccak256("commit"),
            "Fee test",
            packs
        );
        assertEq(raffle.getRafflePolicy(id).buyerFeeBps, 0);
        nft.approve(address(raffle), tokenId);
        raffle.escrow(id);
        _approveAdmission(raffle, id);
        raffle.openWithPolicy(id, raffle.openingPolicyHash());
        vm.stopPrank();
    }

    function _buy(uint256 id, address buyer, uint8 pack, uint32 qty) internal returns (uint256 paid) {
        uint256 principal = uint256(raffle.getPack(id, pack).priceUsdc) * qty;
        paid = principal + _processingFee(principal);
        usdc.mint(buyer, paid);
        vm.startPrank(buyer);
        usdc.approve(address(raffle), paid);
        raffle.buyPack(id, pack, qty, TERMS);
        vm.stopPrank();
        assertEq(usdc.balanceOf(buyer), 0);
    }

    function _draw(uint256 id) internal {
        vm.warp(raffle.getRaffle(id).salesEnd);
        raffle.close(id);
        raffle.snapshot(id, 100);
        raffle.requestRandomness(id);
    }

    function _settle(uint256 id) internal {
        _draw(id);
        vrf.fulfill(address(raffle), raffle.getRaffle(id).vrfRequestId, 0);
        vm.warp(vm.getBlockTimestamp() + raffle.REVEAL_GRACE());
        raffle.settle(id);
    }

    function _lifetime(uint256 id, uint256 gross, uint256 fees) internal view {
        LabxRaffle.RaffleAccounting memory accounting = raffle.getRaffleAccounting(id);
        assertEq(accounting.grossPrincipal, gross);
        assertEq(accounting.buyerFees, fees);
    }
}

contract PercentageFeesTest is PercentageFeeFixture {
    function test_minimumCrossoverMicroRoundingAndSmartWalletCalls() public {
        uint128[6] memory prices = [uint128(1), 124_999_999, 125_000_000, 125_000_049, 125_000_050, 200_000_000];
        uint256[6] memory fees = [uint256(2_500_000), 2_500_000, 2_500_000, 2_500_000, 2_500_001, 4_000_000];
        for (uint256 i; i < prices.length; ++i) {
            uint256 id = _open(prices[i]);
            _buy(id, alice, 0, 1);
            assertEq(raffle.feeOf(id, alice), fees[i]);
        }
        uint256 batchId = _open(25e6);
        FeeBatchBuyer batch = new FeeBatchBuyer();
        usdc.mint(address(batch), 55e6);
        batch.buyTwice(raffle, usdc, batchId, TERMS);
        _buy(batchId, bob, 0, 2);
        assertEq(raffle.principalOf(batchId, address(batch)), raffle.principalOf(batchId, bob));
        assertEq(raffle.feeOf(batchId, address(batch)), 5e6);
        assertEq(raffle.feeOf(batchId, bob), 2_500_000);
    }

    function test_purchaseRoundingBoundariesAndMaxQuantity() public {
        uint128[5] memory prices = [uint128(1), 49, 50, 51, 1_000_000e6];
        for (uint256 i; i < prices.length; ++i) {
            uint256 id = _open(prices[i]);
            _buy(id, alice, 0, 1);
            _buy(id, bob, 0, 20);
            uint256 gross = uint256(prices[i]) * 21;
            uint256 fees = _processingFee(prices[i]) + _processingFee(uint256(prices[i]) * 20);
            _lifetime(id, gross, fees);
            assertEq(raffle.getRaffle(id).principalEscrow, gross);
            assertEq(raffle.getRaffle(id).feeEscrow, fees);
        }
    }

    function testFuzz_purchaseCreditsActualFeeAndRefundsPrincipal(uint128 price, uint32 qty) public {
        price = uint128(bound(price, 1, 1_000_000e6));
        qty = uint32(bound(qty, 1, 20));
        uint256 id = _open(price);
        uint256 principal = uint256(price) * qty;
        uint256 fee = _processingFee(principal);
        uint256 paid = _buy(id, alice, 0, qty);
        assertEq(raffle.principalOf(id, alice), principal);
        assertEq(raffle.feeOf(id, alice), fee);
        assertEq(usdc.balanceOf(address(raffle)), paid);
        vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(id);
        vm.prank(alice);
        raffle.refund(id);
        assertEq(usdc.balanceOf(alice), uint256(price) * qty);
        assertEq(usdc.balanceOf(address(raffle)), fee);
        raffle.claimFee(id);
        assertEq(usdc.balanceOf(address(raffle)), 0);
        _lifetime(id, principal, fee);
    }

    function test_quantityUsesOneMinimumAndSplitCallsRepeatIt() public {
        uint256 id = _open(49);
        _buy(id, alice, 0, 2);
        _buy(id, bob, 0, 1);
        _buy(id, bob, 0, 1);
        assertEq(raffle.principalOf(id, alice), 98);
        assertEq(raffle.principalOf(id, bob), 98);
        assertEq(raffle.feeOf(id, alice), 2_500_000);
        assertEq(raffle.feeOf(id, bob), 5_000_000);
        _lifetime(id, 196, 7_500_000);
    }

    function testFuzz_ethRouteCreditsSameUsdcAndRefunds(uint128 price, uint32 qty) public {
        price = uint128(bound(price, 1, 1_000_000e6));
        qty = uint32(bound(qty, 1, 20));
        uint256 id = _open(price);
        uint256 paid = _buy(id, alice, 0, qty);
        uint256 quoted = raffle.quoteEthForUsdc(paid);
        vm.deal(bob, quoted);
        vm.prank(bob);
        raffle.buyPackWithEth{value: quoted}(id, 0, qty, TERMS, 0, vm.getBlockTimestamp() + 300);
        assertEq(raffle.principalOf(id, alice), raffle.principalOf(id, bob));
        assertEq(raffle.feeOf(id, alice), raffle.feeOf(id, bob));
        assertEq(usdc.balanceOf(address(raffle)), paid * 2);
        vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(id);
        vm.prank(alice);
        raffle.refund(id);
        vm.prank(bob);
        raffle.refund(id);
        assertEq(usdc.balanceOf(alice), uint256(price) * qty);
        assertEq(usdc.balanceOf(bob), uint256(price) * qty);
        assertEq(usdc.balanceOf(address(raffle)), (paid - uint256(price) * qty) * 2);
        raffle.claimFee(id);
        assertEq(usdc.balanceOf(address(raffle)), 0);
    }

    function _mixedSales(uint256 id) internal {
        _buy(id, alice, 0, 1);
        _buy(id, alice, 0, 1);
        _buy(id, bob, 1, 1);
        _buy(id, cara, 0, 2);
        _lifetime(id, 247, 10_000_000); // Four calls each pay the minimum.
    }

    function test_allClaimOrdersAndSettlementOnlyChargesOnce() public {
        uint8[3][6] memory orders = [
            [uint8(0), 1, 2], [uint8(0), 2, 1], [uint8(1), 0, 2], [uint8(1), 2, 0], [uint8(2), 0, 1], [uint8(2), 1, 0]
        ];
        for (uint256 i; i < orders.length; ++i) {
            uint256 id = _open(49);
            _mixedSales(id);
            _settle(id);
            assertEq(raffle.getRaffle(id).principalEscrow, 243);
            assertEq(raffle.getRaffle(id).feeEscrow, 10_000_004);
            vm.expectRevert(LabxRaffle.BadPhase.selector);
            raffle.settle(id);
            for (uint256 j; j < 3; ++j) {
                uint8 action = orders[i][j];
                if (action == 0) {
                    vm.prank(alice);
                    raffle.claimPrize(id);
                }
                if (action == 1) {
                    vm.prank(seller);
                    raffle.claimProceeds(id);
                }
                if (action == 2) raffle.claimFee(id);
                _lifetime(id, 247, 10_000_000);
            }
            assertEq(raffle.getRaffle(id).principalEscrow, 0);
            assertEq(raffle.getRaffle(id).feeEscrow, 0);
            vm.prank(seller);
            vm.expectRevert(LabxRaffle.NotClaimable.selector);
            raffle.claimProceeds(id);
            vm.expectRevert(LabxRaffle.NotClaimable.selector);
            raffle.claimFee(id);
        }
        assertEq(usdc.balanceOf(seller), 243 * 6);
        assertEq(usdc.balanceOf(treasury), 10_000_004 * 6);
        assertEq(usdc.balanceOf(address(raffle)), 0);
    }

    function testFuzz_partialAndFullRefundsKeepLifetimeTotals(bool drawing) public {
        uint256 id = _open(49);
        _mixedSales(id);
        if (drawing) {
            _draw(id);
            vm.warp(vm.getBlockTimestamp() + raffle.VRF_ABORT_AFTER());
            raffle.abortDrawing(id);
        } else {
            vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
            raffle.cancel(id);
        }
        vm.prank(bob);
        raffle.refund(id);
        assertEq(usdc.balanceOf(bob), 51);
        assertEq(raffle.getRaffle(id).principalEscrow, 196);
        assertEq(raffle.getRaffle(id).feeEscrow, 10_000_000);
        _lifetime(id, 247, 10_000_000);
        vm.prank(alice);
        raffle.refund(id);
        vm.prank(cara);
        raffle.refund(id);
        assertEq(usdc.balanceOf(alice), 98);
        assertEq(usdc.balanceOf(cara), 98);
        _lifetime(id, 247, 10_000_000);
        assertEq(usdc.balanceOf(address(raffle)), 10_000_000);
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(usdc.balanceOf(treasury), 0);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.settle(id);
    }

    function testFuzz_failedPayoutKeepsItsEscrowAndDoesNotBlockOtherClaims(bool sellerFails) public {
        uint256 id = _open(49);
        _mixedSales(id);
        _settle(id);
        address blocked = sellerFails ? seller : treasury;
        uint256 amount = sellerFails ? 243 : 10_000_004;
        bytes memory failure = abi.encodeWithSignature("Error(string)", "recipient blocked");
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, blocked, amount), failure);
        if (sellerFails) {
            vm.prank(seller);
            vm.expectRevert(failure);
            raffle.claimProceeds(id);
            assertEq(raffle.getRaffle(id).principalEscrow, 243);
            raffle.claimFee(id);
        } else {
            vm.expectRevert(failure);
            raffle.claimFee(id);
            assertEq(raffle.getRaffle(id).feeEscrow, 10_000_004);
            vm.prank(seller);
            raffle.claimProceeds(id);
        }
        vm.prank(alice);
        raffle.claimPrize(id);
        _lifetime(id, 247, 10_000_000);
        vm.clearMockedCalls();
        if (sellerFails) {
            vm.prank(seller);
            raffle.claimProceeds(id);
        } else {
            raffle.claimFee(id);
        }
        assertEq(usdc.balanceOf(seller), 243);
        assertEq(usdc.balanceOf(treasury), 10_000_004);
        assertEq(usdc.balanceOf(address(raffle)), 0);
    }

    function test_twoRaffleObligationsExcludeUnsolicitedSurplus() public {
        uint256 settled = _open(49);
        uint256 cancelled = _open(49);
        _mixedSales(settled);
        _buy(cancelled, alice, 0, 2);
        _buy(cancelled, bob, 1, 1);
        usdc.mint(address(raffle), 7);
        _backingWithSurplus(settled, cancelled);
        _settle(settled);
        raffle.cancel(cancelled);
        _backingWithSurplus(settled, cancelled);
        vm.prank(bob);
        raffle.refund(cancelled);
        _backingWithSurplus(settled, cancelled);
        raffle.claimFee(settled);
        _backingWithSurplus(settled, cancelled);
        vm.prank(alice);
        raffle.refund(cancelled);
        _backingWithSurplus(settled, cancelled);
        vm.prank(seller);
        raffle.claimProceeds(settled);
        _backingWithSurplus(settled, cancelled);
        raffle.claimFee(cancelled);
        _backingWithSurplus(settled, cancelled);
        assertEq(usdc.balanceOf(address(raffle)), 7);
        _lifetime(settled, 247, 10_000_000);
        _lifetime(cancelled, 149, 5_000_000);
    }

    function _backingWithSurplus(uint256 a, uint256 b) internal view {
        LabxRaffle.RaffleView memory first = raffle.getRaffle(a);
        LabxRaffle.RaffleView memory second = raffle.getRaffle(b);
        assertEq(
            usdc.balanceOf(address(raffle)),
            first.principalEscrow + first.feeEscrow + second.principalEscrow + second.feeEscrow + 7
        );
    }

    function test_openingHashIncludesBothFixedFeeRates() public {
        uint256 id = _open(49);
        LabxRaffle.RafflePolicy memory policy = raffle.getRafflePolicy(id);
        assertEq(raffle.contractVersion(), 3);
        assertEq(policy.buyerFeeBps, 200);
        assertEq(policy.sellerFeeBps, 200);
        assertEq(policy.minBuyerFeeUsdc, 2_500_000);
        bytes32 expected = keccak256(abi.encode(block.chainid, address(raffle), policy));
        assertEq(raffle.openingPolicyHash(), expected);
        policy.buyerFeeBps = 0;
        assertNotEq(keccak256(abi.encode(block.chainid, address(raffle), policy)), expected);
        policy.buyerFeeBps = 200;
        policy.sellerFeeBps = 0;
        assertNotEq(keccak256(abi.encode(block.chainid, address(raffle), policy)), expected);
        _lifetime(999, 0, 0);
    }
}
