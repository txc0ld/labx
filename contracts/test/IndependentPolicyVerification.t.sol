// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {VRFV2PlusClient} from "../src/vendor/VRFV2PlusClient.sol";
import {MockERC20, MockERC721, MockVRF, SyncVRF} from "./mocks/Mocks.sol";

contract IndependentReusableVRF is MockVRF {
    function reuse(uint256 requestId) external {
        next = requestId;
    }
}

contract IndependentMismatchedSyncVRF is MockVRF {
    uint256 internal constant CALLBACK_ID = 41;
    uint256 internal constant RETURN_ID = 42;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        override
        returns (uint256 id)
    {
        lastNativePayment = abi.decode(req.extraArgs[4:], (bool));
        uint256[] memory words = new uint256[](1);
        words[0] = 2;
        LabxRaffle(payable(msg.sender)).rawFulfillRandomWords(CALLBACK_ID, words);
        return RETURN_ID;
    }
}

contract IndependentPolicyVerificationTest is Test {
    bytes32 internal constant TERMS = keccak256("terms-v2");
    bytes32 internal constant KEY = keccak256("vrf-key");

    MockERC20 internal usdc;
    MockERC721 internal nft;
    IndependentReusableVRF internal vrf;
    LabxRaffle internal raffle;
    uint256 internal originalChain;

    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal outsider = makeAddr("outsider");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        originalChain = block.chainid;
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrf = new IndependentReusableVRF();
        raffle = _deploy(address(vrf), treasury);
        _fund(alice);
        _fund(bob);
    }

    function test_checkedOpenHashIsDomainSeparatedAndRejectsWrongChainReview() public {
        LabxRaffle other = _deploy(address(vrf), treasury);
        assertNotEq(raffle.openingPolicyHash(), other.openingPolicyHash());

        uint256 id = _draft(raffle, 1, uint64(block.timestamp + 2 days));
        vm.prank(seller);
        raffle.escrow(id);
        bytes32 reviewed = raffle.openingPolicyHash();

        vm.chainId(originalChain + 1);
        assertNotEq(raffle.openingPolicyHash(), reviewed);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.OpeningPolicyChanged.selector);
        raffle.openWithPolicy(id, reviewed);
        assertEq(uint256(raffle.getRaffle(id).phase), uint256(LabxRaffle.Phase.Draft));

        vm.chainId(originalChain);
        assertEq(raffle.openingPolicyHash(), reviewed);
        vm.prank(seller);
        raffle.openWithPolicy(id, reviewed);
        assertEq(uint256(raffle.getRaffle(id).phase), uint256(LabxRaffle.Phase.Open));
        assertEq(keccak256(abi.encode(block.chainid, address(raffle), raffle.getRafflePolicy(id))), reviewed);
    }

    function test_activeRequestIdCollisionRollsBackWithoutDamagingEitherRaffle() public {
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 firstId = _draft(raffle, 1, end);
        uint256 secondId = _draft(raffle, 2, end);
        _openAndBuy(raffle, firstId, alice);
        _openAndBuy(raffle, secondId, bob);
        _readyAndRequest(raffle, firstId);

        uint256 requestId = raffle.getRaffle(firstId).vrfRequestId;
        assertEq(requestId, 1);
        assertEq(raffle.activeDrawings(), 1);
        assertEq(raffle.requestToRaffle(address(vrf), requestId), firstId);

        _ready(raffle, secondId);
        vrf.reuse(requestId);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.RequestAlreadyUsed.selector);
        raffle.requestRandomness(secondId);

        LabxRaffle.RaffleView memory secondState = raffle.getRaffle(secondId);
        assertEq(uint256(secondState.phase), uint256(LabxRaffle.Phase.Closed));
        assertEq(secondState.vrfRequestId, 0);
        assertEq(secondState.vrfRequestedAt, 0);
        assertEq(raffle.activeDrawings(), 1);
        assertEq(raffle.requestToRaffle(address(vrf), requestId), firstId);

        vrf.fulfill(address(raffle), requestId, 0);
        assertEq(raffle.getRaffle(firstId).winner, alice);
        assertEq(uint256(raffle.getRaffle(secondId).phase), uint256(LabxRaffle.Phase.Closed));
        assertEq(raffle.activeDrawings(), 0);
    }

    function test_synchronousSuccessfulRequestIdCannotBeReusedForAnotherRaffle() public {
        SyncVRF sync = new SyncVRF();
        LabxRaffle target = _deploy(address(sync), treasury);
        _approve(target, alice);
        _approve(target, bob);
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 firstId = _draft(target, 11, end);
        uint256 secondId = _draft(target, 12, end);
        _openAndBuy(target, firstId, alice);
        _openAndBuy(target, secondId, bob);

        _readyAndRequest(target, firstId);
        assertEq(target.getRaffle(firstId).vrfRequestId, 77);
        assertEq(target.getRaffle(firstId).winner, alice);
        assertEq(target.activeDrawings(), 0);

        _ready(target, secondId);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.RequestAlreadyUsed.selector);
        target.requestRandomness(secondId);

        assertEq(uint256(target.getRaffle(firstId).phase), uint256(LabxRaffle.Phase.Drawn));
        assertEq(target.getRaffle(firstId).winner, alice);
        assertEq(uint256(target.getRaffle(secondId).phase), uint256(LabxRaffle.Phase.Closed));
        assertEq(target.getRaffle(secondId).vrfRequestId, 0);
        assertEq(target.requestToRaffle(address(sync), 77), firstId);
        assertEq(target.activeDrawings(), 0);
    }

    function test_mismatchedSynchronousCallbackIdCannotSelectWinnerAndReturnedIdCanFulfill() public {
        IndependentMismatchedSyncVRF mismatch = new IndependentMismatchedSyncVRF();
        LabxRaffle target = _deploy(address(mismatch), treasury);
        _approve(target, alice);
        uint256 id = _draft(target, 13, uint64(block.timestamp + 2 days));
        _openAndBuy(target, id, alice);

        _readyAndRequest(target, id);

        LabxRaffle.RaffleView memory drawing = target.getRaffle(id);
        assertEq(uint256(drawing.phase), uint256(LabxRaffle.Phase.Drawing));
        assertEq(drawing.vrfRequestId, 42);
        assertEq(drawing.winner, address(0));
        assertEq(drawing.randomWord, 0);
        assertEq(target.activeDrawings(), 1);
        assertEq(target.requestToRaffle(address(mismatch), 41), 0);
        assertFalse(target.requestUsed(address(mismatch), 41));
        assertEq(target.requestToRaffle(address(mismatch), 42), id);
        assertTrue(target.requestUsed(address(mismatch), 42));

        mismatch.fulfill(address(target), 42, 0);
        assertEq(uint256(target.getRaffle(id).phase), uint256(LabxRaffle.Phase.Drawn));
        assertEq(target.getRaffle(id).winner, alice);
        assertEq(target.activeDrawings(), 0);
    }

    function test_foreignCallbackCannotSelectWinnerOrBlockTimedRefundAndReclaim() public {
        uint256 id = _draft(raffle, 14, uint64(block.timestamp + 2 days));
        _openAndBuy(raffle, id, alice);
        _readyAndRequest(raffle, id);
        LabxRaffle.RaffleView memory requested = raffle.getRaffle(id);
        uint256 requestId = requested.vrfRequestId;
        uint256[] memory words = new uint256[](1);
        words[0] = 0;

        vm.prank(outsider);
        raffle.rawFulfillRandomWords(requestId, words);

        LabxRaffle.RaffleView memory afterForeign = raffle.getRaffle(id);
        assertEq(uint256(afterForeign.phase), uint256(LabxRaffle.Phase.Drawing));
        assertEq(afterForeign.winner, address(0));
        assertEq(afterForeign.randomWord, 0);
        assertEq(afterForeign.vrfRequestId, requestId);
        assertEq(raffle.requestToRaffle(address(vrf), requestId), id);
        assertEq(raffle.requestToRaffle(outsider, requestId), 0);
        assertEq(raffle.activeDrawings(), 1);

        vm.warp(uint256(requested.vrfRequestedAt) + raffle.VRF_ABORT_AFTER());
        vm.prank(outsider);
        raffle.abortDrawing(id);
        vrf.fulfill(address(raffle), requestId, 0);
        assertEq(uint256(raffle.getRaffle(id).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(raffle.getRaffle(id).winner, address(0));
        assertEq(raffle.activeDrawings(), 0);

        vm.prank(alice);
        raffle.refund(id);
        vm.prank(seller);
        raffle.reclaimPrize(id);
        assertEq(usdc.balanceOf(alice), 1_000e6);
        assertEq(usdc.balanceOf(address(raffle)), 0);
        assertEq(nft.ownerOf(14), seller);
    }

    function test_pauseCannotBlockLifecycleClaimsOrTimedRefund() public {
        uint64 end = uint64(block.timestamp + 2 days);
        uint256 winnerId = _draft(raffle, 21, end);
        uint256 refundId = _draft(raffle, 22, end);
        _openAndBuy(raffle, winnerId, alice);
        _openAndBuy(raffle, refundId, bob);

        raffle.setPaused(true);
        _readyAndRequest(raffle, winnerId);
        uint256 requestId = raffle.getRaffle(winnerId).vrfRequestId;
        vrf.fulfill(address(raffle), requestId, 0);
        vm.prank(seller);
        raffle.reveal(winnerId, _publicHash(21), _privateHash(21), _salt(21));
        vm.prank(outsider);
        raffle.settle(winnerId);

        vm.prank(outsider);
        raffle.claimFee(winnerId);
        vm.prank(seller);
        raffle.claimProceeds(winnerId);
        vm.prank(alice);
        raffle.claimPrize(winnerId);

        vm.warp(uint256(end) + raffle.DRAW_START_GRACE());
        vm.prank(outsider);
        raffle.cancel(refundId);
        vm.prank(bob);
        raffle.refund(refundId);
        vm.prank(seller);
        raffle.reclaimPrize(refundId);

        assertEq(nft.ownerOf(21), alice);
        assertEq(nft.ownerOf(22), seller);
        assertEq(usdc.balanceOf(seller), 25e6);
        assertEq(usdc.balanceOf(treasury), 5e6);
        assertEq(usdc.balanceOf(alice), 970e6);
        assertEq(usdc.balanceOf(bob), 1_000e6);
        assertEq(usdc.balanceOf(address(raffle)), 0);

        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotWinner.selector);
        raffle.claimPrize(winnerId);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.NotClaimable.selector);
        raffle.claimPrize(winnerId);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.NotClaimable.selector);
        raffle.claimProceeds(winnerId);
        vm.expectRevert(LabxRaffle.NotClaimable.selector);
        raffle.claimFee(winnerId);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        raffle.refund(refundId);
    }

    function test_legacyEntryAndSignerSelectorsCannotCreateLots() public {
        uint256 id = _draft(raffle, 31, uint64(block.timestamp + 2 days));
        _open(raffle, id);
        assertEq(raffle.lotCount(id), 0);

        vm.prank(alice);
        vm.expectRevert(LabxRaffle.FreeEntryDisabled.selector);
        raffle.claimAmoe(id, keccak256("legacy-captcha"), block.timestamp + 1 hours, hex"deadbeef");
        assertEq(raffle.lotCount(id), 0);

        (bool ok,) = address(raffle).call(abi.encodeWithSignature("setAmoeSigner(address)", alice));
        assertFalse(ok);
        assertEq(raffle.lotCount(id), 0);
    }

    function _deploy(address coordinator, address feeRecipient) internal returns (LabxRaffle target) {
        target = new LabxRaffle(
            LabxRaffle.Init({
                treasury: feeRecipient,
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 3000,
                vrfCoordinator: coordinator,
                keyHash: KEY,
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
    }

    function _packs() internal pure returns (LabxRaffle.PackConfig[] memory configs) {
        configs = new LabxRaffle.PackConfig[](1);
        configs[0] = LabxRaffle.PackConfig({name: "Membership", priceUsdc: 25e6, bonusEntries: 3, maxSupply: 100});
    }

    function _draft(LabxRaffle target, uint256 tokenId, uint64 end) internal returns (uint256 id) {
        nft.mint(seller, tokenId);
        vm.prank(seller);
        nft.approve(address(target), tokenId);
        bytes32 nonce = keccak256(abi.encode("nonce", tokenId));
        bytes32 commitment = target.hashCommitment(
            nonce, address(nft), tokenId, _publicHash(tokenId), _privateHash(tokenId), _salt(tokenId)
        );
        vm.prank(seller);
        id = target.createRaffle(address(nft), tokenId, end, nonce, commitment, "Independent", _packs());
    }

    function _open(LabxRaffle target, uint256 id) internal {
        vm.startPrank(seller);
        target.escrow(id);
        target.openWithPolicy(id, target.openingPolicyHash());
        vm.stopPrank();
    }

    function _openAndBuy(LabxRaffle target, uint256 id, address buyer) internal {
        _open(target, id);
        vm.prank(buyer);
        target.buyPack(id, 0, 1, TERMS);
    }

    function _ready(LabxRaffle target, uint256 id) internal {
        uint256 end = target.getRaffle(id).salesEnd;
        if (block.timestamp < end) vm.warp(end);
        vm.prank(outsider);
        target.close(id);
        vm.prank(outsider);
        target.snapshot(id, 500);
    }

    function _readyAndRequest(LabxRaffle target, uint256 id) internal {
        _ready(target, id);
        vm.prank(seller);
        target.requestRandomness(id);
    }

    function _fund(address buyer) internal {
        usdc.mint(buyer, 1_000e6);
        _approve(raffle, buyer);
    }

    function _approve(LabxRaffle target, address buyer) internal {
        vm.prank(buyer);
        usdc.approve(address(target), type(uint256).max);
    }

    function _publicHash(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encode("public", tokenId));
    }

    function _privateHash(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encode("private", tokenId));
    }

    function _salt(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", tokenId));
    }
}
