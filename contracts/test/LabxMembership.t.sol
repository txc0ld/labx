// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxMembership} from "../src/LabxMembership.sol";
import {ILabxMembership} from "../src/interfaces/ILabxMembership.sol";
import {LabxTerms} from "../src/LabxTerms.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract LabxMembershipTest is LabxTestBase {
    function test_tiersAreAdminConfigurable() public {
        ILabxMembership.Tier memory platinum = membership.tiers(TIER_PLATINUM);
        assertEq(platinum.name, "Platinum");
        assertEq(platinum.rank, 5);
        assertEq(platinum.entries, 150);

        vm.prank(safe);
        membership.updateTier(TIER_PLATINUM, "Platinum", 600e6, 180, 1_200, 5, true);

        platinum = membership.tiers(TIER_PLATINUM);
        assertEq(platinum.priceUsdc, 600e6);
        assertEq(platinum.entries, 180);
    }

    function test_onlyAdminCanConfigureTiers() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0))
        );
        vm.prank(alice);
        membership.addTier("Rogue", 1e6, 1, 0, 9);
    }

    function test_usdcPurchaseChargesFlatFeeToTreasuryAndEscrowsEntryValue() public {
        uint256 price = membership.tiers(TIER_SILVER).priceUsdc; // 100 USDC
        uint96 fee = membership.membershipFeeUsdc(); // 5 USDC
        assertEq(fee, 5e6);
        assertEq(membership.quoteTierTotal(TIER_SILVER), price + fee);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER);

        assertEq(usdc.balanceOf(alice), aliceBefore - price - fee, "buyer pays price + flat fee");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + fee, "flat fee goes to the treasury only");
        assertEq(membership.escrowedEntryValue(), price, "tier price is escrowed as entry value");
        assertEq(usdc.balanceOf(address(membership)), price);
        assertEq(membership.entriesAvailable(alice), 25);

        ILabxMembership.EntryBatch memory batch = membership.batchAt(alice, 0);
        assertEq(batch.valuePerEntry, 4e6, "100 USDC across 25 entries = 4 USDC each");
        assertEq(batch.expiresAt, uint64(block.timestamp) + 365 days, "entries expire 12 months after purchase");
    }

    function test_purchaseSetsMembershipRankAndKeepsTheHighest() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_GOLD);
        assertEq(membership.memberRank(alice), 4);

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
        assertEq(membership.memberRank(alice), 4, "a cheaper pack does not demote a member");

        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_PLATINUM);
        assertEq(membership.memberRank(alice), 5);
    }

    function test_membershipRankLapsesAfterValidity() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_GOLD);
        vm.warp(block.timestamp + 366 days);
        assertEq(membership.memberRank(alice), 0);
    }

    function test_ethPurchaseSwapsToUsdcAndRefundsChange() public {
        uint256 total = membership.quoteTierTotal(TIER_BRONZE); // 54 + 5 USDC
        uint256 expectedEth = swapAdapter.quoteEthForUsdc(total);
        assertEq(expectedEth, (total * 1e20) / ETH_USD);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 ethBefore = alice.balance;

        vm.prank(alice);
        membership.purchaseWithEth{value: 1 ether}(TIER_BRONZE, 0);

        assertEq(membership.entriesAvailable(alice), 12);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + 5e6);
        assertEq(ethBefore - alice.balance, expectedEth, "unspent ETH is refunded to the buyer");
    }

    function test_ethPurchaseRespectsCallerCeiling() public {
        uint256 total = membership.quoteTierTotal(TIER_BRONZE);
        uint256 expectedEth = swapAdapter.quoteEthForUsdc(total);

        vm.expectRevert(
            abi.encodeWithSelector(LabxMembership.EthCostAboveLimit.selector, expectedEth, expectedEth - 1)
        );
        vm.prank(alice);
        membership.purchaseWithEth{value: 1 ether}(TIER_BRONZE, expectedEth - 1);
    }

    function test_purchaseRequiresAcceptedTerms() public {
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 1_000e6);
        vm.prank(stranger);
        usdc.approve(address(membership), type(uint256).max);

        vm.expectRevert(
            abi.encodeWithSelector(LabxTerms.TermsNotAccepted.selector, stranger, terms.TERMS_OF_USE())
        );
        vm.prank(stranger);
        membership.purchaseWithUsdc(TIER_ENTRY);
    }

    function test_republishingTermsForcesReacceptance() public {
        bytes32 key = terms.TERMS_OF_USE();
        vm.prank(safe);
        terms.publish(key, "https://labx.art/legal/terms", keccak256("terms-v2"));

        assertFalse(terms.hasAcceptedAll(alice));
        vm.expectRevert(abi.encodeWithSelector(LabxTerms.TermsNotAccepted.selector, alice, terms.TERMS_OF_USE()));
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        _acceptTerms(alice);
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
        assertEq(membership.entriesAvailable(alice), 5);
    }

    function test_entriesSpendFifoAndCarryValue() public {
        vm.startPrank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY); // 5 entries at 5 USDC
        membership.purchaseWithUsdc(TIER_BRONZE); // 12 entries at 4.50 USDC
        vm.stopPrank();

        assertEq(membership.entriesAvailable(alice), 17);

        vm.prank(address(raffleHouse));
        (uint256 value, uint32 freeCount, uint64 earliestExpiry) = membership.spendEntries(alice, 7);

        assertEq(value, 34e6, "5 entries at 5 USDC from batch 0, then 2 at 4.50 USDC from batch 1");
        assertEq(freeCount, 0);
        assertEq(earliestExpiry, membership.batchAt(alice, 0).expiresAt);
        assertEq(membership.entriesAvailable(alice), 10);
        assertEq(usdc.balanceOf(address(raffleHouse)), 34e6, "pot USDC moves to the raffle house");
    }

    function test_spendRevertsWhenShort() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        vm.expectRevert(abi.encodeWithSelector(LabxMembership.InsufficientEntries.selector, 6, 5));
        vm.prank(address(raffleHouse));
        membership.spendEntries(alice, 6);
    }

    function test_onlySpenderRoleCanSpend() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, membership.ENTRY_SPENDER_ROLE()
            )
        );
        vm.prank(alice);
        membership.spendEntries(alice, 1);
    }

    function test_expiredEntriesCannotBeSpent() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        vm.warp(block.timestamp + 365 days + 1);
        assertEq(membership.entriesAvailable(alice), 0);

        vm.expectRevert(abi.encodeWithSelector(LabxMembership.InsufficientEntries.selector, 1, 0));
        vm.prank(address(raffleHouse));
        membership.spendEntries(alice, 1);
    }

    function test_expirySweepsValueToTreasuryWithNoCashRefund() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER); // 100 USDC of entry value

        vm.warp(block.timestamp + 365 days + 1);

        (uint256[] memory ids, uint256 value) = membership.expirableBatchIds(alice);
        assertEq(ids.length, 1);
        assertEq(value, 100e6);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        uint256 aliceBefore = usdc.balanceOf(alice);

        // Permissionless: a keeper (here, a random wallet) finalises the expiry.
        vm.prank(bob);
        membership.expireBatches(alice, ids);

        assertEq(usdc.balanceOf(treasury), treasuryBefore + 100e6, "expired value moves to the treasury");
        assertEq(usdc.balanceOf(alice), aliceBefore, "the member receives no cash refund");
        assertEq(membership.escrowedEntryValue(), 0);
        assertEq(membership.entriesAvailable(alice), 0);
    }

    function test_expiryIsIdempotentAndRejectsLiveBatches() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        uint256[] memory ids = new uint256[](1);
        vm.expectRevert(abi.encodeWithSelector(LabxMembership.BatchNotExpired.selector, 0));
        membership.expireBatches(alice, ids);

        vm.warp(block.timestamp + 366 days);
        membership.expireBatches(alice, ids);
        uint256 treasuryAfterFirst = usdc.balanceOf(treasury);
        membership.expireBatches(alice, ids); // second sweep is a no-op
        assertEq(usdc.balanceOf(treasury), treasuryAfterFirst);
    }

    function test_partiallySpentBatchExpiresOnlyTheRemainder() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER); // 25 entries at 4 USDC

        vm.prank(address(raffleHouse));
        membership.spendEntries(alice, 10);

        vm.warp(block.timestamp + 366 days);
        (uint256[] memory ids, uint256 value) = membership.expirableBatchIds(alice);
        assertEq(value, 15 * 4e6);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        membership.expireBatches(alice, ids);
        assertEq(usdc.balanceOf(treasury), treasuryBefore + 15 * 4e6);
    }

    function test_freeEntriesCarryNoValue() public {
        vm.prank(address(points));
        membership.creditFreeEntries(alice, 3, "amoe-points");

        assertEq(membership.entriesAvailable(alice), 3);
        (uint32 paid, uint32 free, uint256 value) = membership.entriesBreakdown(alice);
        assertEq(paid, 0);
        assertEq(free, 3);
        assertEq(value, 0);

        vm.prank(address(raffleHouse));
        (uint256 spentValue, uint32 freeCount,) = membership.spendEntries(alice, 3);
        assertEq(spentValue, 0);
        assertEq(freeCount, 3);
    }

    function test_onlyIssuerRoleCanMintFreeEntries() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, membership.ENTRY_ISSUER_ROLE()
            )
        );
        vm.prank(alice);
        membership.creditFreeEntries(alice, 10, "self-serve");
    }

    function test_refundRestoresEntriesWithoutExtendingExpiry() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
        uint64 originalExpiry = membership.batchAt(alice, 0).expiresAt;

        vm.prank(address(raffleHouse));
        (uint256 value,, uint64 earliestExpiry) = membership.spendEntries(alice, 5);

        vm.warp(block.timestamp + 30 days);

        vm.startPrank(address(raffleHouse));
        usdc.approve(address(membership), value);
        membership.refundEntries(alice, 5, 0, value, earliestExpiry);
        vm.stopPrank();

        assertEq(membership.entriesAvailable(alice), 5);
        assertEq(membership.batchAt(alice, 1).expiresAt, originalExpiry, "refunds never extend the 12-month life");
        assertEq(membership.escrowedEntryValue(), value);
    }

    function test_refundOfFreeEntriesGetsFreshValidity() public {
        vm.startPrank(address(raffleHouse));
        membership.refundEntries(alice, 0, 2, 0, 0);
        vm.stopPrank();

        assertEq(membership.entriesAvailable(alice), 2);
        assertEq(membership.batchAt(alice, 0).expiresAt, uint64(block.timestamp) + 365 days);
    }

    function test_rescueCannotTouchMemberEntryValue() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_SILVER);

        vm.expectRevert(LabxMembership.NothingToRescue.selector);
        vm.prank(safe);
        membership.rescueTokens(address(usdc), safe, 1);

        usdc.mint(address(membership), 7e6); // stray transfer
        vm.prank(safe);
        membership.rescueTokens(address(usdc), safe, 7e6);
        assertEq(usdc.balanceOf(safe), 7e6);
    }

    function test_pauseBlocksPurchases() public {
        vm.prank(operator);
        membership.pause();

        vm.expectRevert();
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);

        vm.prank(safe);
        membership.unpause();
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
    }

    function test_tierRoundingDustGoesToTreasury() public {
        vm.prank(safe);
        uint8 tierId = membership.addTier("Odd", 10e6 + 1, 3, 0, 1); // 10.000001 USDC / 3 entries

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(alice);
        membership.purchaseWithUsdc(tierId);

        ILabxMembership.EntryBatch memory batch = membership.batchAt(alice, 0);
        assertEq(batch.valuePerEntry, 3_333_333);
        // 5 USDC flat fee + 2 units of rounding dust.
        assertEq(usdc.balanceOf(treasury), treasuryBefore + 5e6 + 2);
        assertEq(membership.escrowedEntryValue(), uint256(batch.valuePerEntry) * 3);
    }

    function testFuzz_escrowedValueAlwaysMatchesHeldUsdc(uint8 tierSeed, uint8 purchases) public {
        uint8 tierId = uint8(bound(tierSeed, 0, 4));
        uint8 count = uint8(bound(purchases, 1, 8));

        for (uint256 i; i < count; ++i) {
            vm.prank(alice);
            membership.purchaseWithUsdc(tierId);
        }

        assertGe(usdc.balanceOf(address(membership)), membership.escrowedEntryValue());
        assertEq(usdc.balanceOf(address(membership)), membership.escrowedEntryValue());
    }

    function testFuzz_spendNeverExceedsAvailable(uint8 tierSeed, uint32 requested) public {
        uint8 tierId = uint8(bound(tierSeed, 0, 4));
        vm.prank(alice);
        membership.purchaseWithUsdc(tierId);

        uint32 available = membership.entriesAvailable(alice);
        uint32 amount = uint32(bound(requested, 1, uint256(available) * 2));

        vm.prank(address(raffleHouse));
        if (amount > available) {
            vm.expectRevert(abi.encodeWithSelector(LabxMembership.InsufficientEntries.selector, amount, available));
            membership.spendEntries(alice, amount);
        } else {
            membership.spendEntries(alice, amount);
            assertEq(membership.entriesAvailable(alice), available - amount);
        }
    }
}
