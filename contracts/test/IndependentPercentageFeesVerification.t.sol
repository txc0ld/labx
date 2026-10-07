// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdmissionFixture} from "./AdmissionFixture.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockFeed, MockWETH, MockRouter, MockVRF} from "./mocks/Mocks.sol";

contract IndependentPercentageFeesVerificationTest is AdmissionFixture {
    LabxRaffle internal raffle;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockVRF internal vrf;

    address internal seller = makeAddr("independent-seller");
    address internal alice = makeAddr("independent-alice");
    address internal bob = makeAddr("independent-bob");
    address internal outsider = makeAddr("independent-outsider");
    address internal treasury = makeAddr("independent-treasury");
    bytes32 internal constant TERMS = keccak256("independent-fee-terms");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrf = new MockVRF();
        MockWETH weth = new MockWETH();
        MockRouter router = new MockRouter(weth, usdc);
        raffle = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(new MockFeed()),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: keccak256("independent-key"),
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
    }

    function _open() internal returns (uint256 id) {
        uint256 tokenId = raffle.nextId();
        nft.mint(seller, tokenId);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](2);
        packs[0] = LabxRaffle.PackConfig("Forty nine", 49, 1, 100);
        packs[1] = LabxRaffle.PackConfig("Fifty one", 51, 1, 100);
        vm.startPrank(seller);
        id = raffle.createRaffle(
            address(nft),
            tokenId,
            uint64(block.timestamp + 1 days),
            keccak256(abi.encode("nonce", id)),
            keccak256(abi.encode("commit", id)),
            "Independent fee verification",
            packs
        );
        nft.approve(address(raffle), tokenId);
        raffle.escrow(id);
        _approveAdmission(raffle, id);
        raffle.openWithPolicy(id, raffle.openingPolicyHash());
        vm.stopPrank();
    }

    function _buy(uint256 id, address buyer, uint8 packId, uint32 qty) internal returns (uint256 total) {
        uint256 principal = uint256(raffle.getPack(id, packId).priceUsdc) * qty;
        total = principal + _processingFee(principal);
        usdc.mint(buyer, total);
        vm.startPrank(buyer);
        usdc.approve(address(raffle), total);
        raffle.buyPack(id, packId, qty, TERMS);
        vm.stopPrank();
    }

    function _draw(uint256 id) internal {
        vm.warp(raffle.getRaffle(id).salesEnd);
        raffle.close(id);
        raffle.snapshot(id, 100);
        raffle.requestRandomness(id);
        vrf.fulfill(address(raffle), raffle.getRaffle(id).vrfRequestId, 0);
    }

    function test_failedRefundIsAtomicAndCanBeRetriedWithoutChangingLifetimeAccounting() public {
        uint256 id = _open();
        _buy(id, alice, 0, 1);
        _buy(id, alice, 0, 1);
        _buy(id, alice, 1, 1);
        assertEq(raffle.principalOf(id, alice), 149);
        assertEq(raffle.feeOf(id, alice), 7_500_000);

        vm.warp(uint256(raffle.getRaffle(id).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(id);
        bytes memory failure = abi.encodeWithSignature("Error(string)", "refund recipient blocked");
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, alice, 149), failure);
        vm.prank(alice);
        vm.expectRevert(failure);
        raffle.refund(id);

        assertEq(raffle.principalOf(id, alice), 149);
        assertEq(raffle.feeOf(id, alice), 7_500_000);
        assertEq(raffle.getRaffle(id).principalEscrow, 149);
        assertEq(raffle.getRaffle(id).feeEscrow, 7_500_000);
        LabxRaffle.RaffleAccounting memory afterFailure = raffle.getRaffleAccounting(id);
        assertEq(afterFailure.grossPrincipal, 149);
        assertEq(afterFailure.buyerFees, 7_500_000);

        vm.clearMockedCalls();
        vm.expectEmit(true, true, false, true);
        emit LabxRaffle.Refunded(id, alice, 149);
        vm.prank(alice);
        raffle.refund(id);
        assertEq(usdc.balanceOf(alice), 149);
        assertEq(raffle.getRaffle(id).principalEscrow, 0);
        assertEq(raffle.getRaffle(id).feeEscrow, 7_500_000);
        assertEq(raffle.getRaffleAccounting(id).grossPrincipal, 149);
        assertEq(raffle.getRaffleAccounting(id).buyerFees, 7_500_000);

        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.refund(id);
    }

    function test_permissionlessSettlementAndFeeClaimCannotRedirectPinnedTreasuryOrSellerFunds() public {
        uint256 id = _open();
        _buy(id, alice, 0, 2); // principal 98, fee 2,500,000
        _buy(id, bob, 1, 1); // principal 51, fee 2,500,000
        address replacementTreasury = makeAddr("replacement-treasury");
        raffle.setTreasury(replacementTreasury);

        _draw(id);
        vm.warp(uint256(raffle.getRaffle(id).drawnAt) + raffle.REVEAL_GRACE());
        vm.expectEmit(true, true, false, true);
        emit LabxRaffle.Settled(id, alice, 147, 5_000_002);
        vm.prank(outsider);
        raffle.settle(id);

        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotSeller.selector);
        raffle.claimProceeds(id);
        vm.prank(outsider);
        raffle.claimFee(id);
        assertEq(usdc.balanceOf(treasury), 5_000_002);
        assertEq(usdc.balanceOf(replacementTreasury), 0);

        vm.prank(seller);
        raffle.claimProceeds(id);
        assertEq(usdc.balanceOf(seller), 147);
        assertEq(usdc.balanceOf(outsider), 0);
        assertEq(usdc.balanceOf(address(raffle)), 0);
        assertEq(raffle.getRaffleAccounting(id).grossPrincipal, 149);
        assertEq(raffle.getRaffleAccounting(id).buyerFees, 5_000_000);
    }

    function test_failedRefundInOneRaffleDoesNotConsumeBackingForSettledRaffle() public {
        uint256 cancelled = _open();
        uint256 settled = _open();
        _buy(cancelled, alice, 0, 2); // 2,500,098 total
        _buy(settled, bob, 1, 1); // 2,500,051 total
        usdc.mint(address(raffle), 7);

        _draw(settled);
        vm.warp(uint256(raffle.getRaffle(cancelled).salesEnd) + raffle.DRAW_START_GRACE());
        raffle.cancel(cancelled);
        raffle.settle(settled);

        bytes memory failure = abi.encodeWithSignature("Error(string)", "refund temporarily blocked");
        vm.mockCallRevert(address(usdc), abi.encodeWithSelector(usdc.transfer.selector, alice, 98), failure);
        vm.prank(alice);
        vm.expectRevert(failure);
        raffle.refund(cancelled);
        assertEq(usdc.balanceOf(address(raffle)), 5_000_156);

        raffle.claimFee(settled);
        vm.prank(seller);
        raffle.claimProceeds(settled);
        assertEq(usdc.balanceOf(address(raffle)), 2_500_105); // cancelled obligation plus unsolicited 7

        vm.clearMockedCalls();
        vm.prank(alice);
        raffle.refund(cancelled);
        assertEq(usdc.balanceOf(address(raffle)), 2_500_007);
        raffle.claimFee(cancelled);
        assertEq(usdc.balanceOf(address(raffle)), 7);
        assertEq(usdc.balanceOf(treasury), 5_000_001); // Retained fees from both raffles plus settlement commission
        assertEq(usdc.balanceOf(seller), 50);
    }
}
