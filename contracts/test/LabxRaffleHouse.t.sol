// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";
import {LabxMembership} from "../src/LabxMembership.sol";
import {ILabxMembership} from "../src/interfaces/ILabxMembership.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract LabxRaffleHouseTest is LabxTestBase {
    uint256 internal constant RESERVE = 300e6;
    bytes32 internal constant SALT = keccak256("high-entropy-salt-from-the-backend");

    // ------------------------------------------------------------------------------------------
    // Listing and escrow
    // ------------------------------------------------------------------------------------------

    function test_createRaffleEscrowsTheNftImmediately() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);

        assertEq(nft.ownerOf(1), address(raffleHouse), "the prize is held by the contract, not approved");
        (bool escrowed, uint256 escrowedFor) = raffleHouse.escrowedByRaffle(address(nft), 1);
        assertTrue(escrowed);
        assertEq(escrowedFor, raffleId);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(uint8(raffle.status), uint8(LabxRaffleHouse.RaffleStatus.Open));
        assertEq(raffle.seller, seller);
        assertEq(raffle.reserveCommitment, _reserveCommitment(RESERVE, SALT));
        assertEq(raffle.reserveUsdc, 0, "the plaintext reserve is not on-chain before the reveal");
        assertFalse(raffle.reserveRevealed);
    }

    function test_createRaffleRejectsAnEmptyReserveCommitment() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        params.reserveCommitment = bytes32(0);

        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _signListing(params, deadline);
        vm.expectRevert(LabxRaffleHouse.ZeroReserveCommitment.selector);
        vm.prank(curator);
        raffleHouse.createRaffle(params, deadline, signature);
    }

    function test_curatorCannotListWithoutTheSellersSignature() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _signListing(params, deadline);

        // The operator tries to swap in a reserve the seller never agreed to.
        params.reserveCommitment = _reserveCommitment(1e6, SALT);

        vm.expectRevert(LabxRaffleHouse.InvalidSellerSignature.selector);
        vm.prank(curator);
        raffleHouse.createRaffle(params, deadline, signature);
    }

    function test_strangersCannotList() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        vm.expectRevert(LabxRaffleHouse.ListingNotPermitted.selector);
        vm.prank(alice);
        raffleHouse.createRaffle(params, 0, "");
    }

    function test_sameTokenCannotBeListedTwice() public {
        _createRaffle(1, RESERVE, SALT);

        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParams(1, RESERVE, SALT);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _signListing(params, deadline);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.TokenAlreadyEscrowed.selector, address(nft), 1));
        vm.prank(curator);
        raffleHouse.createRaffle(params, deadline, signature);
    }

    function test_escrowedPrizeCannotBeRescued() public {
        _createRaffle(1, RESERVE, SALT);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.TokenEscrowed.selector, address(nft), 1));
        vm.prank(safe);
        raffleHouse.rescueNft(address(nft), 1, 1, LabxRaffleHouse.NftStandard.ERC721, safe);
    }

    function test_erc1155PrizeIsEscrowedAndDelivered() public {
        nft1155.mint(seller, 7, 3);
        vm.prank(seller);
        nft1155.setApprovalForAll(address(raffleHouse), true);

        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParams(7, 1e6, SALT);
        params.nft = address(nft1155);
        params.standard = LabxRaffleHouse.NftStandard.ERC1155;
        params.amount = 3;
        uint256 raffleId = _createRaffle(params);

        assertEq(nft1155.balanceOf(address(raffleHouse), 7), 3);

        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);

        vm.prank(alice);
        raffleHouse.claimPrize(raffleId);
        assertEq(nft1155.balanceOf(alice, 7), 3);
    }

    function test_cancelBeforeEntriesReturnsThePrize() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        vm.prank(curator);
        raffleHouse.cancelBeforeEntries(raffleId);
        assertEq(nft.ownerOf(1), seller);
    }

    // ------------------------------------------------------------------------------------------
    // Entering
    // ------------------------------------------------------------------------------------------

    function test_oneClickPackPurchaseEntersTheRaffle() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);

        uint256 treasuryBefore = usdc.balanceOf(treasury);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_SILVER, 0);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 25, "all 25 bonus entries from the pack land in this raffle");
        assertEq(raffle.pot, 100e6, "each entry carries its purchase value into the pot");
        assertEq(usdc.balanceOf(treasury), treasuryBefore + 5e6, "only the flat fee reaches the treasury");
        assertEq(membership.entriesAvailable(alice), 0);
    }

    function test_oneClickPackPurchaseWithEth() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);

        vm.prank(alice);
        raffleHouse.buyPackWithEth{value: 1 ether}(raffleId, TIER_BRONZE, 0, 0);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 12);
        assertEq(raffle.pot, 54e6);
    }

    function test_memberCanSplitEntriesAcrossRaffles() public {
        uint256 first = _createRaffle(1, RESERVE, SALT);
        uint256 second = _createRaffle(2, RESERVE, SALT);

        vm.startPrank(alice);
        raffleHouse.buyPackWithUsdc(first, TIER_SILVER, 10); // 10 of 25 entries here
        raffleHouse.enterWithEntries(second, 15); // the rest on another raffle
        vm.stopPrank();

        assertEq(raffleHouse.raffles(first).totalEntries, 10);
        assertEq(raffleHouse.raffles(first).pot, 40e6);
        assertEq(raffleHouse.raffles(second).totalEntries, 15);
        assertEq(raffleHouse.raffles(second).pot, 60e6);
        assertEq(membership.entriesAvailable(alice), 0);
    }

    function test_perUserEntryLimitIsEnforced() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        params.maxEntriesPerUser = 5;
        uint256 raffleId = _createRaffle(params);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.PerUserLimit.selector, 5));
        raffleHouse.buyPackWithUsdc(raffleId, TIER_SILVER, 0);

        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_SILVER, 5);
        assertEq(raffleHouse.raffles(raffleId).totalEntries, 5);
    }

    function test_entriesRejectedAfterClose() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        uint64 endsAt = raffleHouse.raffles(raffleId).endsAt;

        vm.warp(endsAt);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.EntriesClosed.selector, endsAt));
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
    }

    function test_freeDirectEntryIsOncePerPersonPerRaffle() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        uint64 deadline = uint64(block.timestamp + 1 hours);

        bytes memory sig = _signFreeEntry(alice, raffleId, keccak256("n1"), deadline);
        raffleHouse.enterFree(raffleId, alice, keccak256("n1"), deadline, sig);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 1, "a free entry carries the same weight as a purchased one");
        assertEq(raffle.pot, 0, "a free entry adds no value to the pot");

        bytes memory sig2 = _signFreeEntry(alice, raffleId, keccak256("n2"), deadline);
        vm.expectRevert(LabxRaffleHouse.FreeEntryAlreadyUsed.selector);
        raffleHouse.enterFree(raffleId, alice, keccak256("n2"), deadline, sig2);
    }

    function test_freeEntryRequiresAnAttestorSignature() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        uint64 deadline = uint64(block.timestamp + 1 hours);

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("FreeEntry(address user,uint256 raffleId,bytes32 nonce,uint64 deadline)"),
                alice,
                raffleId,
                keccak256("n1"),
                deadline
            )
        );
        bytes memory forged = _sign(0xDEAD, raffleHouse.domainSeparator(), structHash);

        vm.expectRevert(LabxRaffleHouse.InvalidAttestor.selector);
        raffleHouse.enterFree(raffleId, alice, keccak256("n1"), deadline, forged);
    }

    function test_freeEntryAttestationIsSingleUse() public {
        uint256 first = _createRaffle(1, RESERVE, SALT);
        uint256 second = _createRaffle(2, RESERVE, SALT);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 nonce = keccak256("reused");

        bytes memory sig = _signFreeEntry(alice, first, nonce, deadline);
        raffleHouse.enterFree(first, alice, nonce, deadline, sig);

        bytes memory sig2 = _signFreeEntry(bob, second, nonce, deadline);
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.NonceUsed.selector, nonce));
        raffleHouse.enterFree(second, bob, nonce, deadline, sig2);
    }

    function test_freeEntryCanBeDisabledPerRaffle() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        params.freeEntryEnabled = false;
        uint256 raffleId = _createRaffle(params);

        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signFreeEntry(alice, raffleId, keccak256("n1"), deadline);
        vm.expectRevert(LabxRaffleHouse.FreeEntryDisabled.selector);
        raffleHouse.enterFree(raffleId, alice, keccak256("n1"), deadline, sig);
    }

    function test_pastHolderAllowlistGrantsBonusEntries() public {
        (bytes32 root, bytes32[] memory proof) = _twoLeafRoot(alice, bob);

        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, RESERVE, SALT);
        params.allowlistRoot = root;
        params.allowlistBonusEntries = 3;
        uint256 raffleId = _createRaffle(params);

        vm.prank(alice);
        raffleHouse.enterWithAllowlist(raffleId, proof);

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        assertEq(raffle.totalEntries, 3);
        assertEq(raffle.pot, 0, "allowlist bonus entries are free and add no pot value");

        vm.expectRevert(LabxRaffleHouse.AllowlistAlreadyUsed.selector);
        vm.prank(alice);
        raffleHouse.enterWithAllowlist(raffleId, proof);

        vm.expectRevert(LabxRaffleHouse.InvalidProof.selector);
        vm.prank(carol);
        raffleHouse.enterWithAllowlist(raffleId, proof);
    }

    // ------------------------------------------------------------------------------------------
    // Close, commit, reveal, draw
    // ------------------------------------------------------------------------------------------

    function test_entryListIsCommittedBeforeTheVrfRequest() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);

        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        vm.prank(bob);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_BRONZE, 0);

        bytes32 commitmentBeforeClose = raffleHouse.raffles(raffleId).entryCommitment;
        assertTrue(commitmentBeforeClose != bytes32(0));

        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        vm.expectEmit(true, false, false, true, address(raffleHouse));
        emit LabxRaffleHouse.EntriesCommitted(raffleId, 17, 2, commitmentBeforeClose);
        raffleHouse.closeEntries(raffleId);

        // The committed chain is reproducible from the public segment list.
        bytes32 replay;
        replay = keccak256(
            abi.encode(
                replay, alice, uint32(5), uint256(25e6), uint8(LabxRaffleHouse.EntryKind.MembershipPack), uint32(5)
            )
        );
        replay = keccak256(
            abi.encode(
                replay, bob, uint32(12), uint256(54e6), uint8(LabxRaffleHouse.EntryKind.MembershipPack), uint32(17)
            )
        );
        assertEq(replay, commitmentBeforeClose, "anyone can recompute the committed entry list");
    }

    function test_closeRequiresTheEntryWindowToHaveEnded() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        uint64 endsAt = raffleHouse.raffles(raffleId).endsAt;
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.EntriesStillOpen.selector, endsAt));
        raffleHouse.closeEntries(raffleId);
    }

    function test_fullHappyPathPaysSellerPotMinusFee() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);

        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_GOLD, 0); // 245 USDC pot
        vm.prank(bob);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_SILVER, 0); // +100 USDC pot = 345 >= 300 reserve

        uint256 pot = raffleHouse.raffles(raffleId).pot;
        assertEq(pot, 345e6);

        _closeRevealAndDraw(raffleId, RESERVE, SALT, 0);

        address winner = raffleHouse.raffles(raffleId).winner;
        assertTrue(winner == alice || winner == bob);

        uint256 sellerBefore = usdc.balanceOf(seller);
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(winner);
        raffleHouse.acceptPrize(raffleId);
        vm.prank(operator);
        raffleHouse.deliverPrize(raffleId);

        assertEq(nft.ownerOf(1), winner, "LABx pays the gas to deliver the prize");
        uint256 fee = (pot * 1_000) / 10_000;
        assertEq(usdc.balanceOf(treasury), treasuryBefore + fee);
        assertEq(usdc.balanceOf(seller), sellerBefore + pot - fee, "seller receives the pot minus the platform fee");
        assertEq(uint8(raffleHouse.raffles(raffleId).status), uint8(LabxRaffleHouse.RaffleStatus.Delivered));
    }

    function test_winnerWeightIsProportionalToEntries() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);

        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0); // 5 entries: tickets 0-4
        vm.prank(bob);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_BRONZE, 0); // 12 entries: tickets 5-16

        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, 1e6, SALT);

        // Find a VRF word whose first rejection-sampling attempt lands inside Alice's range.
        uint256 word;
        while (uint256(keccak256(abi.encode(word, uint256(0)))) % 17 >= 5) {
            ++word;
        }
        vrf.fulfill(requestId, word);
        assertEq(raffleHouse.raffles(raffleId).winner, alice);
    }

    function test_onlyTheCoordinatorCanFulfill() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, 1e6, SALT);

        uint256[] memory words = new uint256[](1);
        words[0] = 1;
        vm.expectRevert();
        vm.prank(alice);
        raffleHouse.rawFulfillRandomWords(requestId, words);
    }

    function test_onlyOperationsCanReveal() public {
        uint256 raffleId = _openClosedRaffleWithEntries(RESERVE, SALT);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, alice, raffleHouse.OPERATIONS_ROLE()
            )
        );
        vm.prank(alice);
        raffleHouse.revealAndDraw(raffleId, RESERVE, SALT);
    }

    // ------------------------------------------------------------------------------------------
    // Claim deadline and redraw
    // ------------------------------------------------------------------------------------------

    function test_unclaimedPrizeIsRedrawnToAnotherEntrant() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        vm.prank(bob);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);

        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);
        address firstWinner = raffleHouse.raffles(raffleId).winner;

        vm.warp(raffleHouse.raffles(raffleId).claimDeadline + 1);
        vm.prank(operator);
        raffleHouse.redraw(raffleId);

        assertTrue(raffleHouse.excludedFromDraw(raffleId, firstWinner));
        assertEq(uint8(raffleHouse.raffles(raffleId).status), uint8(LabxRaffleHouse.RaffleStatus.Closed));

        vm.prank(operator);
        uint256 requestId = raffleHouse.requestRedraw(raffleId);
        vrf.fulfill(requestId, 777);

        address secondWinner = raffleHouse.raffles(raffleId).winner;
        assertTrue(secondWinner != address(0));
        assertTrue(secondWinner != firstWinner, "the stale winner cannot be drawn again");
    }

    function test_redrawRejectedWhileTheClaimWindowIsOpen() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);

        uint64 claimDeadline = raffleHouse.raffles(raffleId).claimDeadline;
        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.ClaimWindowOpen.selector, claimDeadline));
        vm.prank(operator);
        raffleHouse.redraw(raffleId);
    }

    function test_redrawCannotStripAnAcceptedPrize() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);

        vm.prank(alice);
        raffleHouse.acceptPrize(raffleId);
        vm.warp(raffleHouse.raffles(raffleId).claimDeadline + 1);

        vm.expectRevert(LabxRaffleHouse.PrizeAlreadyAccepted.selector);
        vm.prank(operator);
        raffleHouse.redraw(raffleId);
    }

    function test_exhaustedDrawAttemptsFallBackToRefunds() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);

        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);

        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, 1e6, SALT);
        vrf.fulfill(requestId, 1);

        // Only Alice entered, so every redraw lands on the excluded winner until attempts run out.
        for (uint256 i; i < 2; ++i) {
            vm.warp(raffleHouse.raffles(raffleId).claimDeadline + 1);
            vm.prank(operator);
            raffleHouse.redraw(raffleId);
            if (raffleHouse.raffles(raffleId).status != LabxRaffleHouse.RaffleStatus.Closed) break;
            vm.prank(operator);
            uint256 next = raffleHouse.requestRedraw(raffleId);
            vrf.fulfill(next, 2 + i);
            if (raffleHouse.raffles(raffleId).status == LabxRaffleHouse.RaffleStatus.Closed) break;
        }

        // An inconclusive draw returns the raffle to Closed; the timeout then releases the entries.
        LabxRaffleHouse.RaffleStatus status = raffleHouse.raffles(raffleId).status;
        assertTrue(
            status == LabxRaffleHouse.RaffleStatus.Closed || status == LabxRaffleHouse.RaffleStatus.Refunding
        );

        if (status == LabxRaffleHouse.RaffleStatus.Closed) {
            vm.warp(raffleHouse.refundTimeoutAt(raffleId) + 1);
            raffleHouse.forceRefundAfterTimeout(raffleId);
        }
        assertEq(nft.ownerOf(1), seller, "the prize goes back to the seller");

        raffleHouse.refundEntrant(raffleId, alice);
        assertEq(membership.entriesAvailable(alice), 5);
    }

    // ------------------------------------------------------------------------------------------
    // Settlement edge cases
    // ------------------------------------------------------------------------------------------

    function test_freeEntryWinnerPaysSellerNothingButDeliversThePrize() public {
        LabxRaffleHouse.CreateRaffleParams memory params = _defaultRaffleParamsWithMint(1, 0, SALT);
        uint256 raffleId = _createRaffle(params);

        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory sig = _signFreeEntry(alice, raffleId, keccak256("n1"), deadline);
        raffleHouse.enterFree(raffleId, alice, keccak256("n1"), deadline, sig);

        _closeRevealAndDraw(raffleId, 0, SALT, 0);

        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(alice);
        raffleHouse.claimPrize(raffleId);

        assertEq(nft.ownerOf(1), alice);
        assertEq(usdc.balanceOf(seller), sellerBefore, "an empty pot pays the seller nothing");
    }

    function test_nonWinnerCannotClaim() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);

        vm.expectRevert(abi.encodeWithSelector(LabxRaffleHouse.NotWinner.selector, bob));
        vm.prank(bob);
        raffleHouse.claimPrize(raffleId);
    }

    function test_deliverRequiresAcceptance() public {
        uint256 raffleId = _createRaffle(1, 1e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        _closeRevealAndDraw(raffleId, 1e6, SALT, 0);

        vm.expectRevert(LabxRaffleHouse.PrizeNotAccepted.selector);
        vm.prank(operator);
        raffleHouse.deliverPrize(raffleId);
    }

    function test_refundsAreIdempotent() public {
        uint256 raffleId = _createRaffle(1, 10_000e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);

        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        raffleHouse.revealAndRefund(raffleId, 10_000e6, SALT);

        raffleHouse.refundEntrant(raffleId, alice);
        vm.expectRevert(LabxRaffleHouse.AlreadyRefunded.selector);
        raffleHouse.refundEntrant(raffleId, alice);
    }

    function test_refundRejectsNonEntrants() public {
        uint256 raffleId = _createRaffle(1, 10_000e6, SALT);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
        vm.prank(operator);
        raffleHouse.revealAndRefund(raffleId, 10_000e6, SALT);

        vm.expectRevert(LabxRaffleHouse.NothingToRefund.selector);
        raffleHouse.refundEntrant(raffleId, carol);
    }

    function test_pauseBlocksEntries() public {
        uint256 raffleId = _createRaffle(1, RESERVE, SALT);
        vm.prank(operator);
        raffleHouse.pause();

        vm.expectRevert();
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_ENTRY, 0);
    }

    function test_configIsAdminOnly() public {
        LabxRaffleHouse.Config memory config = raffleHouse.config();
        config.platformFeeBps = 500;

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0))
        );
        vm.prank(alice);
        raffleHouse.setConfig(config);

        vm.prank(safe);
        raffleHouse.setConfig(config);
        assertEq(raffleHouse.config().platformFeeBps, 500);
    }

    function test_platformFeeIsCapped() public {
        LabxRaffleHouse.Config memory config = raffleHouse.config();
        config.platformFeeBps = 3_001;
        vm.expectRevert(LabxRaffleHouse.InvalidFee.selector);
        vm.prank(safe);
        raffleHouse.setConfig(config);
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function _openClosedRaffleWithEntries(uint256 reserve, bytes32 salt) internal returns (uint256 raffleId) {
        raffleId = _createRaffle(1, reserve, salt);
        vm.prank(alice);
        raffleHouse.buyPackWithUsdc(raffleId, TIER_PLATINUM, 0);
        vm.warp(raffleHouse.raffles(raffleId).endsAt);
        raffleHouse.closeEntries(raffleId);
    }

    function _closeRevealAndDraw(uint256 raffleId, uint256 reserve, bytes32 salt, uint256 randomWord) internal {
        if (raffleHouse.raffles(raffleId).status == LabxRaffleHouse.RaffleStatus.Open) {
            vm.warp(raffleHouse.raffles(raffleId).endsAt);
            raffleHouse.closeEntries(raffleId);
        }
        vm.prank(operator);
        uint256 requestId = raffleHouse.revealAndDraw(raffleId, reserve, salt);
        vrf.fulfill(requestId, randomWord);
    }
}
