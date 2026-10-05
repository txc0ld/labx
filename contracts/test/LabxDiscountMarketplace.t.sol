// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxDiscountMarketplace} from "../src/LabxDiscountMarketplace.sol";

contract LabxDiscountMarketplaceTest is LabxTestBase {
    address internal partner = makeAddr("partner");

    function test_offerGatedByMembershipRank() public {
        uint256 offerId = _createOffer(3, 0, 0);

        (bool ok, bytes32 reason) = marketplace.canRedeem(offerId, alice);
        assertFalse(ok);
        assertEq(reason, "rank-too-low");

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_BRONZE); // rank 2, still short
        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.RankTooLow.selector, 3, 2));
        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER); // rank 3
        vm.prank(alice);
        bytes32 voucherRef = marketplace.redeem(offerId);
        assertEq(voucherRef, keccak256(abi.encode(address(marketplace), offerId, alice, uint32(1))));
    }

    function test_redemptionEmitsAVoucherReferenceNotACode() public {
        uint256 offerId = _createOffer(0, 0, 0);

        vm.expectEmit(true, true, false, true, address(marketplace));
        emit LabxDiscountMarketplace.OfferRedeemed(
            offerId, alice, 1, 0, keccak256(abi.encode(address(marketplace), offerId, alice, uint32(1)))
        );
        vm.prank(alice);
        marketplace.redeem(offerId);
    }

    function test_stockIsEnforced() public {
        uint256 offerId = _createOffer(0, 1, 0);

        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.OutOfStock.selector, offerId));
        vm.prank(bob);
        marketplace.redeem(offerId);
    }

    function test_perUserLimitIsEnforced() public {
        uint256 offerId = _createOffer(0, 0, 1);

        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.PerUserLimitReached.selector, 1));
        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.prank(bob);
        marketplace.redeem(offerId); // a different member is unaffected
    }

    function test_offerWindowIsEnforced() public {
        vm.prank(curator);
        uint256 offerId = marketplace.createOffer(
            partner, 0, 1_500, 0, 0, uint64(_now() + 1 days), uint64(_now() + 2 days), "ipfs://perk"
        );

        vm.expectRevert(
            abi.encodeWithSelector(LabxDiscountMarketplace.OfferNotStarted.selector, uint64(_now() + 1 days))
        );
        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.warp(_now() + 3 days);
        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.OfferEnded.selector, uint64(_now() - 1 days)));
        vm.prank(alice);
        marketplace.redeem(offerId);
    }

    function test_deactivatedOfferCannotBeRedeemed() public {
        uint256 offerId = _createOffer(0, 0, 0);
        vm.prank(curator);
        marketplace.updateOffer(offerId, 0, 0, uint64(_now() + 30 days), false);

        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.OfferInactive.selector, offerId));
        vm.prank(alice);
        marketplace.redeem(offerId);
    }

    function test_termsMustBeAcceptedToRedeem() public {
        uint256 offerId = _createOffer(0, 0, 0);
        address stranger = makeAddr("stranger");

        (bool ok, bytes32 reason) = marketplace.canRedeem(offerId, stranger);
        assertFalse(ok);
        assertEq(reason, "terms-not-accepted");

        vm.expectRevert();
        vm.prank(stranger);
        marketplace.redeem(offerId);
    }

    function test_onlyCuratorCanCreateOffers() public {
        vm.expectRevert();
        vm.prank(alice);
        marketplace.createOffer(partner, 0, 500, 0, 0, uint64(_now()), uint64(_now() + 1 days), "x");
    }

    function test_lapsedMembershipLosesPerkAccess() public {
        uint256 offerId = _createOffer(2, 0, 0);

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER);
        vm.prank(alice);
        marketplace.redeem(offerId);

        vm.warp(_now() + 366 days);
        vm.prank(curator);
        marketplace.updateOffer(offerId, 0, 0, uint64(_now() + 30 days), true);

        vm.expectRevert(abi.encodeWithSelector(LabxDiscountMarketplace.RankTooLow.selector, 2, 0));
        vm.prank(alice);
        marketplace.redeem(offerId);
    }

    function _createOffer(uint8 minRank, uint32 stock, uint32 perUserLimit) internal returns (uint256 offerId) {
        vm.prank(curator);
        offerId = marketplace.createOffer(
            partner,
            minRank,
            1_500,
            stock,
            perUserLimit,
            uint64(_now()),
            uint64(_now() + 30 days),
            "ipfs://labx/perk"
        );
    }
}
