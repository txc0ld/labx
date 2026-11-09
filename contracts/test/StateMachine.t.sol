// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdmissionFixture} from "./AdmissionFixture.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {VRFV2PlusClient} from "../src/vendor/VRFV2PlusClient.sol";
import {MockERC20, MockERC721, MockVRF} from "./mocks/Mocks.sol";

/// @notice Delivers a chosen old callback, and optionally the new request's own word, inside `requestRandomWords`.
contract ReplayingVRF is MockVRF {
    uint256 public replayId;
    bool public answerNow;

    function replay(uint256 id, bool alsoAnswerNow) external {
        replayId = id;
        answerNow = alsoAnswerNow;
    }

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata) external override returns (uint256 id) {
        id = next++;
        uint256[] memory words = new uint256[](1);
        words[0] = 1;
        if (replayId != 0) LabxRaffle(payable(msg.sender)).rawFulfillRandomWords(replayId, words);
        if (answerNow) LabxRaffle(payable(msg.sender)).rawFulfillRandomWords(id, words);
    }
}

/// @notice A collection that moves a token for its owner or operator without checking `from`, which ERC-721 requires.
contract LaxFromERC721 is MockERC721 {
    function transferFrom(address, address to, uint256 id) public override {
        address o = ownerOf(id);
        require(msg.sender == o || msg.sender == getApproved[id] || isApprovedForAll[o][msg.sender], "auth");
        getApproved[id] = address(0);
        balanceOf[o] -= 1;
        balanceOf[to] += 1;
        _owner[id] = to;
        emit Transfer(o, to, id);
    }
}

/// @notice Executes the transition table in docs/audits/state-machines: every lifecycle function from every phase and
///         time sub-state, plus the orderings that table marks as attacks.
contract StateMachineTest is AdmissionFixture {
    bytes32 internal constant TERMS = keccak256("terms-v1");
    bytes32 internal constant NONCE = bytes32(uint256(7));
    bytes32 internal constant PUBLIC_HASH = keccak256("public");
    bytes32 internal constant PRIVATE_HASH = keccak256("private");
    bytes32 internal constant SALT = bytes32(uint256(9));
    uint256 internal constant TOKEN = 1;

    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockVRF internal vrf;

    address internal treasury = makeAddr("treasury");
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal outsider = makeAddr("outsider");

    /// @dev One row of the table per value, in lifecycle order.
    enum S {
        None,
        Draft,
        DraftEscrowed,
        DraftApproved,
        OpenEmpty,
        OpenSold,
        OpenEnded,
        OpenExpired,
        ClosedUncounted,
        ClosedPartial,
        ClosedCounted,
        ClosedExpired,
        Drawing,
        DrawingExpired,
        DrawnHidden,
        DrawnRevealed,
        DrawnGraceOver,
        Settled,
        Cancelled
    }

    /// @dev One column of the table per value.
    enum A {
        UpdateDraft,
        Escrow,
        Approve,
        Revoke,
        Open,
        Buy,
        Close,
        Snapshot,
        Request,
        Fulfill,
        Abort,
        CancelSeller,
        CancelOwner,
        CancelOutsider,
        Reveal,
        Settle,
        ClaimPrize,
        ClaimProceeds,
        ClaimFee,
        Reclaim,
        Refund
    }

    uint256 internal constant STATES = 19;
    uint256 internal constant ACTIONS = 21;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrf = new MockVRF();
        labx = _deploy(address(vrf));
        labx.setPaused(false);
        nft.mint(seller, TOKEN);
        vm.prank(seller);
        nft.setApprovalForAll(address(labx), true);
        _fund(alice);
        _fund(bob);
    }

    function _deploy(address coordinator) internal returns (LabxRaffle) {
        return new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 0,
                vrfCoordinator: coordinator,
                keyHash: keccak256("key"),
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 400_000,
                requestConfirmations: 3
            })
        );
    }

    function _fund(address buyer) internal {
        usdc.mint(buyer, 1_000_000e6);
        vm.prank(buyer);
        usdc.approve(address(labx), type(uint256).max);
    }

    function _configs() internal pure returns (LabxRaffle.PackConfig[] memory configs) {
        configs = new LabxRaffle.PackConfig[](1);
        configs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 25e6, bonusEntries: 2, maxSupply: 100});
    }

    function _createFor(LabxRaffle target, address collection, address from, uint256 token)
        internal
        returns (uint256 id)
    {
        bytes32 commit = target.hashCommitment(NONCE, collection, token, PUBLIC_HASH, PRIVATE_HASH, SALT);
        vm.prank(from);
        id = target.createRaffle(
            collection, token, uint64(vm.getBlockTimestamp() + 2 days), NONCE, commit, "Junction Array", _configs()
        );
    }

    function _phase(uint256 id) internal view returns (uint8) {
        return uint8(labx.getRaffle(id).phase);
    }

    /// @dev Builds the raffle each table row starts from. Three lots: alice twice, bob once.
    function _build(S s) internal returns (uint256 id) {
        id = labx.nextId();
        if (s == S.None) return id;
        _createFor(labx, address(nft), seller, TOKEN);
        if (s == S.Draft) return id;
        vm.prank(seller);
        labx.escrow(id);
        if (s == S.DraftEscrowed) return id;
        _approveAdmission(labx, id);
        if (s == S.DraftApproved) return id;
        vm.prank(seller);
        labx.open(id);
        if (s == S.OpenEmpty) return id;
        vm.prank(alice);
        labx.buyPack(id, 0, 1, TERMS);
        vm.prank(alice);
        labx.buyPack(id, 0, 2, TERMS);
        vm.prank(bob);
        labx.buyPack(id, 0, 1, TERMS);
        if (s == S.OpenSold) return id;
        uint256 salesEnd = labx.getRaffle(id).salesEnd;
        if (s == S.OpenExpired || s == S.Cancelled) {
            vm.warp(salesEnd + 7 days);
            if (s == S.Cancelled) {
                vm.prank(outsider);
                labx.cancel(id);
            }
            return id;
        }
        vm.warp(salesEnd);
        if (s == S.OpenEnded) return id;
        labx.close(id);
        if (s == S.ClosedUncounted) return id;
        labx.snapshot(id, 1);
        if (s == S.ClosedPartial) return id;
        labx.snapshot(id, 300);
        if (s == S.ClosedCounted) return id;
        if (s == S.ClosedExpired) {
            vm.warp(salesEnd + 7 days);
            return id;
        }
        labx.requestRandomness(id);
        if (s == S.Drawing) return id;
        if (s == S.DrawingExpired) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            return id;
        }
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 3);
        if (s == S.DrawnHidden) return id;
        if (s == S.DrawnGraceOver) {
            vm.warp(vm.getBlockTimestamp() + 7 days);
            return id;
        }
        vm.prank(seller);
        labx.reveal(id, PUBLIC_HASH, PRIVATE_HASH, SALT);
        if (s == S.DrawnRevealed) return id;
        labx.settle(id);
        return id;
    }

    /// @dev Runs one table column as the caller the table names. Returns false when the call reverted.
    function _act(A a, uint256 id) internal returns (bool ok) {
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = outsider;
        bytes memory data;
        if (a == A.UpdateDraft) {
            from = seller;
            bytes32 commit = labx.hashCommitment(NONCE, address(nft), TOKEN, PUBLIC_HASH, PRIVATE_HASH, SALT);
            data = abi.encodeCall(
                LabxRaffle.updateDraft,
                (id, address(nft), TOKEN, uint64(vm.getBlockTimestamp() + 1 days), NONCE, commit, "Edited", _configs())
            );
        } else if (a == A.Escrow) {
            from = seller;
            data = abi.encodeCall(LabxRaffle.escrow, (id));
        } else if (a == A.Approve || a == A.Revoke) {
            from = address(this);
            bytes32 digest;
            try labx.draftReviewHash(id) returns (bytes32 current) {
                digest = current;
            } catch {}
            data = a == A.Approve
                ? abi.encodeCall(LabxRaffle.approveRaffle, (id, digest))
                : abi.encodeCall(LabxRaffle.revokeRaffleApproval, (id, digest));
        } else if (a == A.Open) {
            from = seller;
            data = abi.encodeCall(LabxRaffle.open, (id));
        } else if (a == A.Buy) {
            from = alice;
            data = abi.encodeCall(LabxRaffle.buyPack, (id, 0, 1, TERMS));
        } else if (a == A.Close) {
            data = abi.encodeCall(LabxRaffle.close, (id));
        } else if (a == A.Snapshot) {
            data = abi.encodeCall(LabxRaffle.snapshot, (id, 1));
        } else if (a == A.Request) {
            data = abi.encodeCall(LabxRaffle.requestRandomness, (id));
        } else if (a == A.Fulfill) {
            from = address(vrf);
            uint256[] memory words = new uint256[](1);
            words[0] = 3;
            // The live request while one exists; otherwise request 1, which is this raffle's only request, used or not.
            data = abi.encodeCall(LabxRaffle.rawFulfillRandomWords, (r.vrfRequestId == 0 ? 1 : r.vrfRequestId, words));
        } else if (a == A.Abort) {
            data = abi.encodeCall(LabxRaffle.abortDrawing, (id));
        } else if (a == A.CancelSeller || a == A.CancelOwner || a == A.CancelOutsider) {
            from = a == A.CancelSeller ? seller : a == A.CancelOwner ? address(this) : outsider;
            data = abi.encodeCall(LabxRaffle.cancel, (id));
        } else if (a == A.Reveal) {
            from = seller;
            data = abi.encodeCall(LabxRaffle.reveal, (id, PUBLIC_HASH, PRIVATE_HASH, SALT));
        } else if (a == A.Settle) {
            data = abi.encodeCall(LabxRaffle.settle, (id));
        } else if (a == A.ClaimPrize) {
            from = r.winner == address(0) ? alice : r.winner;
            data = abi.encodeCall(LabxRaffle.claimPrize, (id));
        } else if (a == A.ClaimProceeds) {
            from = seller;
            data = abi.encodeCall(LabxRaffle.claimProceeds, (id));
        } else if (a == A.ClaimFee) {
            data = abi.encodeCall(LabxRaffle.claimFee, (id));
        } else if (a == A.Reclaim) {
            from = seller;
            data = abi.encodeCall(LabxRaffle.reclaimPrize, (id));
        } else {
            from = alice;
            data = abi.encodeCall(LabxRaffle.refund, (id));
        }
        vm.prank(from);
        (ok,) = address(labx).call(data);
    }

    /// @dev One string per state, one character per action in enum order: '-' means the call reverts, a digit is the
    ///      phase after it succeeds (0 Draft, 1 Open, 2 Closed, 3 Drawing, 4 Drawn, 5 Settled, 6 Cancelled).
    function _table() internal pure returns (string[STATES] memory t) {
        t[uint256(S.None)] = "---------0-----------";
        t[uint256(S.Draft)] = "00-------0-66--------";
        t[uint256(S.DraftEscrowed)] = "0-0------0-66--------";
        t[uint256(S.DraftApproved)] = "0-001----0-66--------";
        t[uint256(S.OpenEmpty)] = "-----1---1-66-1------";
        t[uint256(S.OpenSold)] = "-----1---1----1------";
        t[uint256(S.OpenEnded)] = "------2--1----1------";
        t[uint256(S.OpenExpired)] = "------2--1-6661------";
        t[uint256(S.ClosedUncounted)] = "-------2-2----2------";
        t[uint256(S.ClosedPartial)] = "-------2-2----2------";
        t[uint256(S.ClosedCounted)] = "--------32----2------";
        t[uint256(S.ClosedExpired)] = "---------2-6662------";
        t[uint256(S.Drawing)] = "---------4----3------";
        t[uint256(S.DrawingExpired)] = "---------36---3------";
        t[uint256(S.DrawnHidden)] = "---------4----4------";
        t[uint256(S.DrawnRevealed)] = "---------4-----5-----";
        t[uint256(S.DrawnGraceOver)] = "---------4----45-----";
        t[uint256(S.Settled)] = "---------5------555--";
        t[uint256(S.Cancelled)] = "---------6--------666";
    }

    /// @dev Actions that must revert when repeated straight after they succeed.
    function _onceOnly(A a) internal pure returns (bool) {
        return a != A.UpdateDraft && a != A.Approve && a != A.Buy && a != A.Snapshot && a != A.Fulfill;
    }

    function _checkTable(bool paused) internal {
        string[STATES] memory table = _table();
        for (uint256 s; s < STATES; ++s) {
            uint256 built = vm.snapshotState();
            uint256 id = _build(S(s));
            if (paused) labx.setPaused(true);
            for (uint256 a; a < ACTIONS; ++a) {
                bytes1 want = bytes(table[s])[a];
                // Pause blocks opening and buying, and nothing else in the table.
                if (paused && (A(a) == A.Open || A(a) == A.Buy)) want = "-";
                uint256 before = vm.snapshotState();
                bool ok = _act(A(a), id);
                string memory cell = string.concat("state ", vm.toString(s), " action ", vm.toString(a));
                assertEq(ok, want != "-", cell);
                if (ok) {
                    assertEq(_phase(id), uint8(want) - 48, cell);
                    if (_onceOnly(A(a))) assertFalse(_act(A(a), id), string.concat(cell, " repeated"));
                }
                vm.revertToState(before);
            }
            vm.revertToState(built);
        }
    }

    function test_everyFunctionFromEveryStateMatchesTheTransitionTable() public {
        _checkTable(false);
    }

    function test_pauseOnlyRemovesOpenAndBuyFromTheTransitionTable() public {
        _checkTable(true);
    }

    /// @dev A late callback for an aborted request, delivered inside another raffle's request, lands in the
    ///      synchronous capture slot. It must not draw either raffle, and the new request must stay answerable.
    function test_abortedCallbackInsideAnotherRequestDrawsNeitherRaffle() public {
        ReplayingVRF replaying = new ReplayingVRF();
        labx = _deploy(address(replaying));
        labx.setPaused(false);
        vm.prank(seller);
        nft.setApprovalForAll(address(labx), true);
        _fund(alice);
        nft.mint(seller, 2);

        uint256 first = _drawingOn(TOKEN);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.abortDrawing(first);

        uint256 second = _countedOn(2);
        replaying.replay(1, false);
        labx.requestRandomness(second);

        assertEq(_phase(first), uint8(LabxRaffle.Phase.Cancelled));
        assertEq(labx.getRaffle(first).winner, address(0));
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawing));
        assertEq(labx.getRaffle(second).vrfRequestId, 2);
        assertEq(labx.activeDrawings(), 1);

        replaying.fulfill(address(labx), 1, 5);
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawing));
        replaying.fulfill(address(labx), 2, 5);
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawn));
        assertEq(labx.getRaffle(second).winner, alice);
        assertEq(labx.activeDrawings(), 0);
    }

    /// @dev The capture slot holds one callback. When a stale one fills it first, the request's own same-transaction
    ///      word is dropped, the raffle stays Drawing, and a later delivery of the same request still draws it.
    function test_staleCallbackCanDisplaceASameTransactionWordButNotTheRequest() public {
        ReplayingVRF replaying = new ReplayingVRF();
        labx = _deploy(address(replaying));
        labx.setPaused(false);
        vm.prank(seller);
        nft.setApprovalForAll(address(labx), true);
        _fund(alice);
        nft.mint(seller, 2);

        uint256 first = _drawingOn(TOKEN);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.abortDrawing(first);

        uint256 second = _countedOn(2);
        replaying.replay(1, true);
        labx.requestRandomness(second);
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawing));
        assertEq(labx.activeDrawings(), 1);

        replaying.fulfill(address(labx), 2, 5);
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawn));
        assertEq(labx.activeDrawings(), 0);
    }

    function _countedOn(uint256 token) internal returns (uint256 id) {
        id = _createFor(labx, address(nft), seller, token);
        vm.prank(seller);
        labx.escrow(id);
        _approveAdmission(labx, id);
        vm.prank(seller);
        labx.open(id);
        vm.prank(alice);
        labx.buyPack(id, 0, 1, TERMS);
        vm.warp(labx.getRaffle(id).salesEnd);
        labx.close(id);
        labx.snapshot(id, 300);
    }

    function _drawingOn(uint256 token) internal returns (uint256 id) {
        id = _countedOn(token);
        labx.requestRandomness(id);
    }

    /// @dev A coordinator change while a draw is in flight: the old coordinator still answers its request, the new
    ///      one cannot, and equal request ids on the two coordinators stay separate raffles.
    function test_coordinatorChangeMidDrawLeavesEachRequestWithItsOwnCoordinator() public {
        nft.mint(seller, 2);
        uint256 first = _drawingOn(TOKEN);
        MockVRF next = new MockVRF();
        labx.proposeCoordinator(address(next));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        labx.applyCoordinator();

        uint256 second = _drawingOn(2);
        assertEq(labx.getRafflePolicy(first).coordinator, address(vrf));
        assertEq(labx.getRafflePolicy(second).coordinator, address(next));
        assertEq(labx.getRaffle(first).vrfRequestId, 1);
        assertEq(labx.getRaffle(second).vrfRequestId, 1);
        assertEq(labx.activeDrawings(), 2);

        next.fulfill(address(labx), 1, 0);
        assertEq(_phase(first), uint8(LabxRaffle.Phase.Drawing));
        assertEq(_phase(second), uint8(LabxRaffle.Phase.Drawn));
        vrf.fulfill(address(labx), 1, 0);
        assertEq(_phase(first), uint8(LabxRaffle.Phase.Drawn));
        assertEq(labx.activeDrawings(), 0);
    }

    /// @dev Finding C1. `escrowed` is a flag per raffle, and custody is `ownerOf == this`, which is true for every
    ///      raffle that names the same token. A standard collection refuses the second escrow because `from` is not
    ///      the owner. One that skips that check lets a stranger mark a draft as escrowed with a token already held
    ///      for a live raffle, cancel the draft, and take the token. No approval is involved.
    function test_collectionThatIgnoresFromLetsAStrangerTakeALivePrize() public {
        LaxFromERC721 lax = new LaxFromERC721();
        lax.mint(seller, TOKEN);
        vm.prank(seller);
        lax.setApprovalForAll(address(labx), true);

        uint256 live = _createFor(labx, address(lax), seller, TOKEN);
        vm.prank(seller);
        labx.escrow(live);
        _approveAdmission(labx, live);
        vm.prank(seller);
        labx.open(live);
        vm.prank(alice);
        labx.buyPack(live, 0, 1, TERMS);

        uint256 copy = _createFor(labx, address(lax), outsider, TOKEN);
        vm.startPrank(outsider);
        labx.escrow(copy);
        assertTrue(labx.getRaffle(copy).escrowed);
        assertTrue(labx.getRaffle(live).escrowed);
        labx.cancel(copy);
        labx.reclaimPrize(copy);
        vm.stopPrank();

        assertEq(lax.ownerOf(TOKEN), outsider);
        // The live raffle still says it holds the prize, sells, and can draw; its winner's claim then reverts.
        assertTrue(labx.getRaffle(live).escrowed);
        assertEq(_phase(live), uint8(LabxRaffle.Phase.Open));
        vm.prank(bob);
        labx.buyPack(live, 0, 1, TERMS);
        vm.warp(labx.getRaffle(live).salesEnd);
        labx.close(live);
        labx.snapshot(live, 300);
        labx.requestRandomness(live);
        vrf.fulfill(address(labx), labx.getRaffle(live).vrfRequestId, 0);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        labx.settle(live);
        vm.prank(alice);
        vm.expectRevert(bytes("auth"));
        labx.claimPrize(live);
        // The seller is still paid for a prize the winner cannot receive.
        vm.prank(seller);
        labx.claimProceeds(live);
        assertEq(usdc.balanceOf(seller), 49e6);
    }

    /// @dev The control for C1: a collection that checks `from`, as ERC-721 requires, refuses the second escrow.
    function test_standardCollectionRefusesASecondEscrowOfAHeldToken() public {
        uint256 live = _createFor(labx, address(nft), seller, TOKEN);
        vm.prank(seller);
        labx.escrow(live);

        uint256 copy = _createFor(labx, address(nft), outsider, TOKEN);
        vm.prank(outsider);
        vm.expectRevert(bytes("from"));
        labx.escrow(copy);
        uint256 again = _createFor(labx, address(nft), seller, TOKEN);
        vm.prank(seller);
        vm.expectRevert(bytes("from"));
        labx.escrow(again);
        assertFalse(labx.getRaffle(copy).escrowed);
        assertFalse(labx.getRaffle(again).escrowed);
    }

    /// @dev An ERC-20 shares the `transferFrom` selector with ERC-721, so a draft naming USDC as its collection must
    ///      never reach `escrowed`. It cannot: escrow calls `safeTransferFrom` and `ownerOf`, which USDC lacks.
    function test_draftNamingUsdcAsItsCollectionCannotEscrowOrReclaim() public {
        usdc.mint(address(labx), 500e6);
        uint256 id = _createFor(labx, address(usdc), outsider, 500e6);
        vm.startPrank(outsider);
        vm.expectRevert();
        labx.escrow(id);
        labx.cancel(id);
        vm.expectRevert(LabxRaffle.NotClaimable.selector);
        labx.reclaimPrize(id);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(labx)), 500e6);
    }

    /// @dev A pending owner can be replaced, also by the owner itself, but never cleared. Accepting bumps the owner
    ///      generation even when the owner address does not change, which voids every unopened approval.
    function test_pendingOwnerIsReplacedNotClearedAndSelfAcceptVoidsApprovals() public {
        uint256 id = _createFor(labx, address(nft), seller, TOKEN);
        vm.prank(seller);
        labx.escrow(id);
        _approveAdmission(labx, id);

        labx.transferOwnership(outsider);
        vm.expectRevert(LabxRaffle.ZeroAddress.selector);
        labx.transferOwnership(address(0));
        labx.transferOwnership(address(this));
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotPendingOwner.selector);
        labx.acceptOwnership();

        // Still openable: a pending owner alone changes nothing.
        uint256 beforeAccept = vm.snapshotState();
        vm.prank(seller);
        labx.open(id);
        vm.revertToState(beforeAccept);

        labx.acceptOwnership();
        assertEq(labx.owner(), address(this));
        assertEq(labx.pendingOwner(), address(0));
        assertEq(labx.ownerGeneration(), 1);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        labx.open(id);
    }
}
