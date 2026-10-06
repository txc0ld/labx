// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockVRF, SyncVRF} from "./mocks/Mocks.sol";
import {VRFV2PlusClient} from "../src/vendor/VRFV2PlusClient.sol";

contract RecordingVRF is MockVRF {
    bytes32 public requestedKey;
    uint256 public requestedSubscription;
    uint32 public requestedGas;
    uint16 public requestedConfirmations;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        override
        returns (uint256 id)
    {
        requestedKey = req.keyHash;
        requestedSubscription = req.subId;
        requestedGas = req.callbackGasLimit;
        requestedConfirmations = req.requestConfirmations;
        lastNativePayment = abi.decode(req.extraArgs[4:], (bool));
        return next++;
    }

    function reuse(uint256 id) external {
        next = id;
    }
}

contract BuyerProtectionTest is Test {
    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    RecordingVRF internal first;
    RecordingVRF internal second;
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal treasury = makeAddr("treasury");
    bytes32 internal constant TERMS = keccak256("terms");
    bytes32 internal constant KEY = keccak256("key");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        first = new RecordingVRF();
        second = new RecordingVRF();
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 3000,
                vrfCoordinator: address(first),
                keyHash: KEY,
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
        usdc.mint(alice, 1_000e6);
        usdc.mint(bob, 1_000e6);
        vm.prank(alice);
        usdc.approve(address(labx), 1_000e6);
        vm.prank(bob);
        usdc.approve(address(labx), 1_000e6);
    }

    function _packs(uint256 count) internal pure returns (LabxRaffle.PackConfig[] memory packs) {
        packs = new LabxRaffle.PackConfig[](count);
        for (uint256 i; i < count; ++i) {
            packs[i] = LabxRaffle.PackConfig("Membership", 25e6, 3, 100);
        }
    }

    function _draft(uint256 token, uint64 end) internal returns (uint256 id) {
        nft.mint(seller, token);
        vm.startPrank(seller);
        nft.approve(address(labx), token);
        id = labx.createRaffle(address(nft), token, end, bytes32(uint256(1)), bytes32(uint256(2)), "Piece", _packs(2));
        vm.stopPrank();
    }

    function _open(uint256 id) internal {
        vm.startPrank(seller);
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
    }

    function _buy(uint256 id, address buyer, bytes32 terms) internal {
        vm.prank(buyer);
        labx.buyPack(id, 0, 1, terms);
    }

    function _request(uint256 id) internal {
        uint256 end = labx.getRaffle(id).salesEnd;
        if (vm.getBlockTimestamp() < end) vm.warp(end);
        labx.close(id);
        labx.snapshot(id, 500);
        vm.prank(seller);
        labx.requestRandomness(id);
    }

    function test_fullPolicyAndTreasuryAreFrozenAtOpen() public {
        uint64 end = uint64(vm.getBlockTimestamp() + 3 days);
        uint256 oldId = _draft(1, end);
        _open(oldId);
        address nextTreasury = makeAddr("nextTreasury");
        bytes32 nextTerms = keccak256("nextTerms");
        labx.setTreasury(nextTreasury);
        labx.setTermsHash(nextTerms);
        labx.setVrfConfig(keccak256("nextKey"), 9, 600_000, 5);
        labx.setNativePayment(true);
        labx.proposeCoordinator(address(second));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        labx.applyCoordinator();
        uint256 newId = _draft(2, end);
        _open(newId);
        _buy(oldId, alice, TERMS);
        _buy(newId, bob, nextTerms);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.TermsMismatch.selector);
        labx.buyPack(oldId, 0, 1, nextTerms);
        _request(oldId);
        _request(newId);
        assertEq(first.requestedKey(), KEY);
        assertEq(first.requestedSubscription(), 1);
        assertEq(first.requestedGas(), 500_000);
        assertEq(first.requestedConfirmations(), 3);
        assertFalse(first.lastNativePayment());
        assertEq(second.requestedKey(), keccak256("nextKey"));
        assertEq(second.requestedSubscription(), 9);
        assertEq(second.requestedGas(), 600_000);
        assertEq(second.requestedConfirmations(), 5);
        assertTrue(second.lastNativePayment());
        // Both independent coordinators returned 1. Neither overwrote the other raffle.
        assertEq(labx.requestToRaffle(address(first), 1), oldId);
        assertEq(labx.requestToRaffle(address(second), 1), newId);
        second.fulfill(address(labx), 1, 9);
        assertEq(labx.getRaffle(oldId).winner, address(0));
        assertEq(labx.getRaffle(newId).winner, bob);
        first.fulfill(address(labx), 1, 3);
        assertEq(labx.getRaffle(oldId).winner, alice);
        assertEq(labx.activeDrawings(), 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.settle(oldId);
        labx.settle(newId);
        labx.setTreasury(makeAddr("thirdTreasury"));
        vm.prank(bob);
        labx.claimFee(oldId);
        vm.prank(alice);
        labx.claimFee(newId);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(usdc.balanceOf(nextTreasury), 5e6);
    }

    function test_syncCallbackUsesPinnedCoordinatorAfterDefaultChanges() public {
        SyncVRF sync = new SyncVRF();
        labx.proposeCoordinator(address(sync));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        labx.applyCoordinator();
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        _open(id);
        _buy(id, alice, TERMS);
        labx.proposeCoordinator(address(second));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        labx.applyCoordinator();
        _request(id);
        assertEq(labx.getRaffle(id).winner, alice);
        assertEq(labx.requestToRaffle(address(sync), 77), id);
        assertEq(labx.activeDrawings(), 0);
    }

    function test_abortedRequestCannotBeReusedOrAffectAnotherCoordinator() public {
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        _open(id);
        _buy(id, alice, TERMS);
        _request(id);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.abortDrawing(id);
        assertEq(labx.requestToRaffle(address(first), 1), 0);
        assertTrue(labx.requestUsed(address(first), 1));
        uint256 nextId = _draft(2, uint64(vm.getBlockTimestamp() + 3 days));
        _open(nextId);
        _buy(nextId, bob, TERMS);
        first.reuse(1);
        vm.warp(labx.getRaffle(nextId).salesEnd);
        labx.close(nextId);
        labx.snapshot(nextId, 500);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.RequestAlreadyUsed.selector);
        labx.requestRandomness(nextId);
        first.fulfill(address(labx), 1, 0);
        assertEq(labx.getRaffle(nextId).winner, address(0));
        assertEq(labx.activeDrawings(), 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.cancel(nextId);
        vm.prank(alice);
        labx.refund(id);
        vm.prank(bob);
        labx.refund(nextId);
        assertEq(usdc.balanceOf(address(labx)), 0);
    }

    function test_pauseStopsAdmissionsButCannotStopDrawOrClaims() public {
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        _open(id);
        _buy(id, alice, TERMS);
        uint256 draftId = _draft(2, uint64(vm.getBlockTimestamp() + 3 days));
        vm.prank(seller);
        labx.escrow(draftId);
        labx.setPaused(true);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.Paused.selector);
        labx.open(draftId);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.Paused.selector);
        labx.buyPack(id, 0, 1, TERMS);
        _request(id);
        first.fulfill(address(labx), 1, 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.settle(id);
        vm.prank(alice);
        labx.claimPrize(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        labx.claimFee(id);
        assertEq(nft.ownerOf(1), alice);
        assertEq(usdc.balanceOf(seller), 25e6);
        assertEq(usdc.balanceOf(treasury), 5e6);
    }

    function test_draftEditingClearsRemovedPacksAndLocksEscrowIdentity() public {
        uint64 end = uint64(vm.getBlockTimestamp() + 3 days);
        uint256 id = _draft(1, end);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.NotSeller.selector);
        labx.updateDraft(id, address(nft), 1, end, bytes32(uint256(4)), bytes32(uint256(5)), "Edited", _packs(1));
        vm.prank(seller);
        labx.updateDraft(
            id, address(nft), 1, end + 1 days, bytes32(uint256(4)), bytes32(uint256(5)), "Edited", _packs(1)
        );
        assertEq(labx.getRaffle(id).title, "Edited");
        assertEq(labx.getRaffle(id).packCount, 1);
        assertFalse(labx.getPack(id, 1).active);
        assertEq(labx.getPack(id, 1).maxSupply, 0);
        vm.prank(seller);
        labx.escrow(id);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.EscrowIdentityLocked.selector);
        labx.updateDraft(id, address(nft), 2, end, bytes32(uint256(4)), bytes32(uint256(5)), "Edited", _packs(1));
        vm.prank(seller);
        labx.updateDraft(id, address(nft), 1, end, bytes32(uint256(6)), bytes32(uint256(7)), "Ready", _packs(2));
        vm.prank(seller);
        labx.open(id);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.updateDraft(id, address(nft), 1, end, bytes32(uint256(6)), bytes32(uint256(7)), "Again", _packs(2));
        assertEq(labx.getRaffle(id).title, "Ready");
        assertEq(nft.ownerOf(1), address(labx));
    }

    function testFuzz_noRoleCanCloseEarlyOrCancelPurchasedMembership(uint8 role, uint32 quantity) public {
        quantity = uint32(bound(quantity, 1, 20));
        uint64 end = uint64(vm.getBlockTimestamp() + 3 days);
        uint256 id = _draft(1, end);
        _open(id);
        vm.prank(alice);
        labx.buyPack(id, 0, quantity, TERMS);
        address caller = role % 3 == 0 ? seller : role % 3 == 1 ? address(this) : bob;
        vm.warp(end - 1);
        vm.prank(caller);
        vm.expectRevert(LabxRaffle.TooEarly.selector);
        labx.close(id);
        vm.prank(caller);
        vm.expectRevert();
        labx.cancel(id);
        vm.warp(end);
        vm.prank(caller);
        labx.close(id);
        vm.prank(caller);
        vm.expectRevert();
        labx.cancel(id);
        vm.warp(uint256(end) + 7 days);
        vm.prank(caller);
        labx.cancel(id);
        vm.prank(alice);
        labx.refund(id);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(labx.lotCount(id), 1);
    }

    function testFuzz_checkedOpenRejectsChangedDefaultsAndAcceptsExactPolicy(uint8 field) public {
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        vm.prank(seller);
        labx.escrow(id);
        bytes32 reviewed = labx.openingPolicyHash();
        uint256 choice = field % 5;
        if (choice == 0) {
            labx.setTreasury(bob);
        } else if (choice == 1) {
            labx.setTermsHash(keccak256("newTerms"));
        } else if (choice == 2) {
            labx.setVrfConfig(keccak256("newKey"), 2, 600_000, 5);
        } else if (choice == 3) {
            labx.setNativePayment(true);
        } else {
            labx.proposeCoordinator(address(second));
            vm.warp(vm.getBlockTimestamp() + 1 days);
            labx.applyCoordinator();
        }
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.OpeningPolicyChanged.selector);
        labx.openWithPolicy(id, reviewed);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Draft));
        bytes32 current = labx.openingPolicyHash();
        assertNotEq(current, reviewed);
        vm.prank(seller);
        labx.openWithPolicy(id, current);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Open));
        assertEq(keccak256(abi.encode(block.chainid, address(labx), labx.getRafflePolicy(id))), current);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.openWithPolicy(id, current);
    }

    function test_nonexistentRaffleCannotBeCancelledOrPoisonFutureDraft() public {
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.cancel(1);
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Draft));
        _open(id);
    }

    function test_unfundedDraftAndOpenCanStillCancelAndReclaim() public {
        uint256 id = _draft(1, uint64(vm.getBlockTimestamp() + 3 days));
        _open(id);
        vm.prank(seller);
        labx.cancel(id);
        vm.prank(seller);
        labx.reclaimPrize(id);
        assertEq(nft.ownerOf(1), seller);
        uint256 draftId = _draft(2, uint64(vm.getBlockTimestamp() + 3 days));
        vm.prank(seller);
        labx.escrow(draftId);
        labx.cancel(draftId);
        vm.prank(seller);
        labx.reclaimPrize(draftId);
        assertEq(nft.ownerOf(2), seller);
    }
}
