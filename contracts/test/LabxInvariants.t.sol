// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxMembership} from "../src/LabxMembership.sol";
import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";
import {MockERC721} from "./mocks/MockERC721.sol";

/// @notice Drives random sequences of real user actions against a live raffle and checks the solvency
///         properties that matter: member entry value is always fully backed by USDC, and a raffle pot
///         never exceeds the USDC the raffle house actually holds.
contract LabxHandler is LabxTestBase {
    uint256 public raffleId;
    address[] public actors;
    uint256 public closedAtSnapshot;

    function initialise() external {
        actors.push(alice);
        actors.push(bob);
        actors.push(carol);
        raffleId = _createRaffle(1, 50e6, keccak256("invariant-salt"));
    }

    function buyPack(uint256 actorSeed, uint8 tierSeed) external {
        if (!_open()) return;
        address actor = actors[actorSeed % actors.length];
        uint8 tierId = uint8(tierSeed % 5);

        vm.prank(actor);
        raffleHouse.buyPackWithUsdc(raffleId, tierId, 0);
    }

    function buyToLedger(uint256 actorSeed, uint8 tierSeed) external {
        address actor = actors[actorSeed % actors.length];
        vm.prank(actor);
        membership.purchaseWithUsdc(uint8(tierSeed % 5));
    }

    function spendLedger(uint256 actorSeed, uint32 count) external {
        if (!_open()) return;
        address actor = actors[actorSeed % actors.length];
        uint32 available = membership.entriesAvailable(actor);
        if (available == 0) return;

        vm.prank(actor);
        raffleHouse.enterWithEntries(raffleId, uint32(1 + (count % available)));
    }

    function claimFreeEntry(uint256 actorSeed, uint256 nonceSeed) external {
        if (!_open()) return;
        address actor = actors[actorSeed % actors.length];
        (bool ok,) = amoe.freeEntryAvailable(raffleId, actor);
        if (!ok) return;

        bytes32 nonce = keccak256(abi.encode(nonceSeed, actor));
        if (amoe.nonceUsed(nonce)) return;
        uint64 deadline = uint64(_now() + 1 hours);
        amoe.claimFreeEntry(raffleId, actor, nonce, deadline, _signFreeEntry(actor, raffleId, nonce, deadline));
    }

    function expireEntries(uint256 actorSeed) external {
        address actor = actors[actorSeed % actors.length];
        (uint256[] memory ids,) = membership.expirableBatchIds(actor);
        if (ids.length == 0) return;
        membership.expireBatches(actor, ids);
    }

    function advanceTime(uint32 seconds_) external {
        vm.warp(_now() + (seconds_ % 30 days) + 1);
    }

    function closeAndSettle(uint256 wordSeed) external {
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        if (raffle.status == LabxRaffleHouse.RaffleStatus.Open) {
            if (_now() < raffle.endsAt) return;
            raffleHouse.closeEntries(raffleId);
            return;
        }
        if (raffle.status != LabxRaffleHouse.RaffleStatus.Closed || raffle.reserveRevealed) return;

        vm.startPrank(operator);
        if (raffle.pot >= 50e6 && raffle.totalEntries != 0) {
            uint256 requestId = raffleHouse.revealAndDraw(raffleId, 50e6, keccak256("invariant-salt"));
            vm.stopPrank();
            vrf.fulfill(requestId, wordSeed);
        } else {
            raffleHouse.revealAndRefund(raffleId, 50e6, keccak256("invariant-salt"));
            vm.stopPrank();
        }
    }

    function claimPrize() external {
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        if (raffle.status != LabxRaffleHouse.RaffleStatus.Won) return;
        if (_now() > raffle.claimDeadline) return;
        vm.prank(raffle.winner);
        raffleHouse.claimPrize(raffleId);
    }

    function refundEntrant(uint256 actorSeed) external {
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        if (raffle.status != LabxRaffleHouse.RaffleStatus.Refunding) return;
        address actor = actors[actorSeed % actors.length];
        (,,,, bool refunded) = _entrant(actor);
        if (refunded) return;
        (uint32 paid, uint32 free,,,) = _entrant(actor);
        if (paid == 0 && free == 0) return;
        raffleHouse.refundEntrant(raffleId, actor);
    }

    function _entrant(address account)
        internal
        view
        returns (uint32 paid, uint32 free, uint128 value, uint64 expiry, bool refunded)
    {
        return raffleHouse.entrants(raffleId, account);
    }

    function membershipContract() external view returns (LabxMembership) {
        return membership;
    }

    function raffleHouseContract() external view returns (LabxRaffleHouse) {
        return raffleHouse;
    }

    function nftContract() external view returns (MockERC721) {
        return nft;
    }

    function _open() internal view returns (bool) {
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        return raffle.status == LabxRaffleHouse.RaffleStatus.Open && _now() < raffle.endsAt;
    }
}

contract LabxInvariantsTest is Test {
    LabxHandler internal handler;

    function setUp() public {
        handler = new LabxHandler();
        handler.setUp();
        handler.initialise();

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = LabxHandler.buyPack.selector;
        selectors[1] = LabxHandler.buyToLedger.selector;
        selectors[2] = LabxHandler.spendLedger.selector;
        selectors[3] = LabxHandler.claimFreeEntry.selector;
        selectors[4] = LabxHandler.expireEntries.selector;
        selectors[5] = LabxHandler.advanceTime.selector;
        selectors[6] = LabxHandler.closeAndSettle.selector;
        selectors[7] = LabxHandler.claimPrize.selector;
        selectors[8] = LabxHandler.refundEntrant.selector;

        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Every entry a member still holds is fully backed by USDC sitting in the membership contract.
    function invariant_memberEntryValueIsFullyBacked() public view {
        LabxMembership membership = handler.membershipContract();
        assertGe(membership.usdc().balanceOf(address(membership)), membership.escrowedEntryValue());
    }

    /// @notice A pot is never larger than the USDC the raffle house actually holds for it.
    function invariant_potIsCovered() public view {
        LabxRaffleHouse raffleHouse = handler.raffleHouseContract();
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(handler.raffleId());
        assertGe(raffleHouse.usdc().balanceOf(address(raffleHouse)), raffle.pot);
    }

    /// @notice The prize is always owned by someone: escrowed here, delivered, or returned to the seller.
    function invariant_prizeIsNeverLost() public view {
        LabxRaffleHouse raffleHouse = handler.raffleHouseContract();
        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(handler.raffleId());
        assertTrue(handler.nftContract().ownerOf(raffle.tokenId) != address(0));
    }
}
