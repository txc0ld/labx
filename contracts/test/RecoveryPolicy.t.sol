// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, StickyERC721, MockFeed, MockWETH, MockRouter, MockVRF} from "./mocks/Mocks.sol";

contract OutboundFailERC20 is IERC20 {
    string public name = "Failure Coin";
    string public symbol = "FAIL";
    uint8 public decimals = 6;
    uint256 public totalSupply;
    bool public failTransfers;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setFailTransfers(bool fail) external {
        failTransfers = fail;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (failTransfers) return false;
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract RecoveryPolicyTest is Test {
    uint256 internal constant TERMS = uint256(keccak256("terms-v1"));
    bytes32 internal constant KEY = keccak256("key");
    uint256 internal constant POLICY_WINDOW = 7 days;

    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockFeed internal feed;
    MockWETH internal weth;
    MockRouter internal router;
    MockVRF internal vrf;

    address internal treasury = makeAddr("treasury");
    address internal nextTreasury = makeAddr("next-treasury");
    address internal signer = makeAddr("signer");
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal cara = makeAddr("cara");
    address internal outsider = makeAddr("outsider");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        feed = new MockFeed();
        weth = new MockWETH();
        router = new MockRouter(weth, usdc);
        vrf = new MockVRF();
        labx = _deploy(address(usdc));
    }

    function test_permissionlessSettlementAtExactGracePreservesWinnerAndPayees() public {
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        uint256 id = _newRaffle(1, salesEnd);
        _open(id);
        _fundAndBuy(labx, usdc, alice, id);
        _readyAndRequest(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);

        LabxRaffle.RaffleView memory drawn = labx.getRaffle(id);
        assertEq(drawn.winner, alice);
        uint256 deadline = uint256(drawn.drawnAt) + POLICY_WINDOW;

        vm.warp(deadline - 1);
        vm.expectRevert(LabxRaffle.RevealRequired.selector);
        labx.settle(id);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.RevealRequired.selector);
        labx.settle(id);

        labx.setTreasury(nextTreasury);
        vm.warp(deadline);
        vm.prank(outsider);
        labx.settle(id);

        LabxRaffle.RaffleView memory settled = labx.getRaffle(id);
        assertEq(settled.winner, alice);
        assertEq(settled.principalEscrow, 24_500_000);
        assertEq(settled.feeEscrow, 1e6);
        assertEq(uint256(settled.phase), uint256(LabxRaffle.Phase.Settled));

        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.settle(id);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.NotWinner.selector);
        labx.claimPrize(id);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.refund(id);

        vm.prank(seller);
        labx.claimProceeds(id);
        vm.prank(outsider);
        labx.claimFee(id);
        vm.prank(alice);
        labx.claimPrize(id);

        assertEq(usdc.balanceOf(seller), 24_500_000);
        assertEq(usdc.balanceOf(nextTreasury), 0);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(nft.ownerOf(1), alice);
        assertEq(usdc.balanceOf(address(labx)), 0);
    }

    function test_preRequestBoundaryCoversPausedOpenPartialEmptyAndCompleteStates() public {
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        uint256 openId = _newRaffle(1, salesEnd);
        uint256 partialId = _newRaffle(2, salesEnd);
        uint256 emptyId = _newRaffle(3, salesEnd);
        uint256 lastSecondId = _newRaffle(4, salesEnd);
        uint256 expiredId = _newRaffle(5, salesEnd);
        _open(openId);
        _open(partialId);
        _open(emptyId);
        _open(lastSecondId);
        _open(expiredId);

        _fund(usdc, alice, address(labx), 500e6);
        _fund(usdc, bob, address(labx), 100e6);
        _buy(labx, alice, openId);
        _buy(labx, alice, partialId);
        _buy(labx, bob, partialId);
        _buy(labx, alice, lastSecondId);
        _buy(labx, alice, expiredId);

        _close(partialId);
        labx.snapshot(partialId, 1);
        assertFalse(labx.getRaffle(partialId).snapshotted);
        _close(emptyId);
        labx.snapshot(emptyId, 5);
        _close(lastSecondId);
        labx.snapshot(lastSecondId, 5);
        _close(expiredId);
        labx.snapshot(expiredId, 5);

        uint256 cutoff = uint256(salesEnd) + POLICY_WINDOW;
        vm.warp(cutoff - 1);
        vm.prank(outsider);
        vm.expectRevert();
        labx.cancel(openId);
        vm.prank(outsider);
        vm.expectRevert();
        labx.cancel(partialId);

        vm.prank(seller);
        labx.requestRandomness(lastSecondId);
        uint256 requestId = labx.getRaffle(lastSecondId).vrfRequestId;
        uint256 requestedAt = labx.getRaffle(lastSecondId).vrfRequestedAt;

        vm.warp(cutoff);
        vm.prank(seller);
        vm.expectRevert();
        labx.requestRandomness(expiredId);
        labx.setPaused(true);

        vm.prank(outsider);
        labx.cancel(openId);
        vm.prank(outsider);
        labx.cancel(partialId);
        vm.prank(outsider);
        labx.cancel(emptyId);
        vm.prank(outsider);
        labx.cancel(expiredId);

        assertEq(uint256(labx.getRaffle(openId).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(uint256(labx.getRaffle(partialId).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(uint256(labx.getRaffle(emptyId).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(uint256(labx.getRaffle(expiredId).phase), uint256(LabxRaffle.Phase.Cancelled));

        _assertRefundAdds(openId, alice, 25_500_000);
        _assertRefundAdds(partialId, alice, 25_500_000);
        _assertRefundAdds(partialId, bob, 25_500_000);
        _assertRefundAdds(expiredId, alice, 25_500_000);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotSeller.selector);
        labx.reclaimPrize(openId);

        vm.warp(requestedAt + POLICY_WINDOW - 1);
        vrf.fulfill(address(labx), requestId, 0);
        assertEq(uint256(labx.getRaffle(lastSecondId).phase), uint256(LabxRaffle.Phase.Drawn));
        assertEq(labx.getRaffle(lastSecondId).winner, alice);
        assertEq(labx.activeDrawings(), 0);
    }

    function test_revertingCoordinatorLeavesClosedRaffleRecoverableAtSalesCutoff() public {
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        uint256 id = _newRaffle(1, salesEnd);
        _open(id);
        _fundAndBuy(labx, usdc, alice, id);
        _close(id);
        labx.snapshot(id, 5);
        assertTrue(labx.getRaffle(id).snapshotted);

        bytes memory coordinatorFailure = abi.encodeWithSignature("Error(string)", "coordinator unavailable");
        vm.mockCallRevert(address(vrf), MockVRF.requestRandomWords.selector, coordinatorFailure);
        vm.warp(uint256(salesEnd) + POLICY_WINDOW - 1);
        vm.prank(seller);
        vm.expectRevert(coordinatorFailure);
        labx.requestRandomness(id);
        vm.clearMockedCalls();

        LabxRaffle.RaffleView memory afterFailure = labx.getRaffle(id);
        assertEq(uint256(afterFailure.phase), uint256(LabxRaffle.Phase.Closed));
        assertEq(afterFailure.vrfRequestId, 0);
        assertEq(afterFailure.vrfRequestedAt, 0);
        assertEq(labx.requestToRaffle(address(vrf), 1), 0);
        assertFalse(labx.requestUsed(address(vrf), 1));
        assertEq(labx.activeDrawings(), 0);
        assertEq(vrf.next(), 1);

        vm.warp(uint256(salesEnd) + POLICY_WINDOW);
        labx.setPaused(true);
        uint256 outsiderBefore = usdc.balanceOf(outsider);
        vm.prank(outsider);
        labx.cancel(id);
        assertEq(usdc.balanceOf(outsider), outsiderBefore);
        _assertRefundAdds(id, alice, 25_500_000);
        assertEq(labx.getRaffle(id).principalEscrow, 0);
        assertEq(labx.getRaffle(id).feeEscrow, 0);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.refund(id);
    }

    function test_callbackAndAbortDeadlinesAreDisjointAcrossBothOrderings() public {
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        uint256 timelyId = _newRaffle(1, salesEnd);
        uint256 callbackFirstId = _newRaffle(2, salesEnd);
        uint256 abortFirstId = _newRaffle(3, salesEnd);
        _open(timelyId);
        _open(callbackFirstId);
        _open(abortFirstId);
        _fund(usdc, alice, address(labx), 100e6);
        _buy(labx, alice, timelyId);
        _buy(labx, alice, callbackFirstId);
        _buy(labx, alice, abortFirstId);
        _readyAndRequest(timelyId);
        _readyAndRequest(callbackFirstId);
        _readyAndRequest(abortFirstId);

        uint256 timelyRequest = labx.getRaffle(timelyId).vrfRequestId;
        uint256 callbackFirstRequest = labx.getRaffle(callbackFirstId).vrfRequestId;
        uint256 abortFirstRequest = labx.getRaffle(abortFirstId).vrfRequestId;
        uint256 deadline = uint256(labx.getRaffle(timelyId).vrfRequestedAt) + POLICY_WINDOW;
        assertEq(labx.VRF_ABORT_AFTER(), POLICY_WINDOW);
        assertEq(labx.activeDrawings(), 3);

        vm.warp(deadline - 1);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.TooEarly.selector);
        labx.abortDrawing(timelyId);
        vrf.fulfill(address(labx), timelyRequest, 0);
        address recordedWinner = labx.getRaffle(timelyId).winner;
        vrf.fulfill(address(labx), timelyRequest, 99);
        assertEq(labx.getRaffle(timelyId).winner, recordedWinner);
        assertEq(labx.activeDrawings(), 2);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.abortDrawing(timelyId);

        vm.warp(deadline);
        vrf.fulfill(address(labx), callbackFirstRequest, 77);
        LabxRaffle.RaffleView memory expired = labx.getRaffle(callbackFirstId);
        assertEq(uint256(expired.phase), uint256(LabxRaffle.Phase.Drawing));
        assertEq(expired.winner, address(0));
        assertEq(expired.randomWord, 0);
        assertEq(expired.vrfRequestId, callbackFirstRequest);
        assertEq(labx.requestToRaffle(address(vrf), callbackFirstRequest), callbackFirstId);
        assertTrue(labx.requestUsed(address(vrf), callbackFirstRequest));
        assertEq(labx.activeDrawings(), 2);

        uint256 outsiderBefore = usdc.balanceOf(outsider);
        vm.prank(outsider);
        labx.abortDrawing(callbackFirstId);
        assertEq(usdc.balanceOf(outsider), outsiderBefore);
        assertEq(labx.requestToRaffle(address(vrf), callbackFirstRequest), 0);
        assertTrue(labx.requestUsed(address(vrf), callbackFirstRequest));
        assertEq(labx.getRaffle(callbackFirstId).vrfRequestId, 0);
        assertEq(labx.activeDrawings(), 1);

        vm.prank(outsider);
        labx.abortDrawing(abortFirstId);
        assertEq(labx.activeDrawings(), 0);
        assertEq(labx.requestToRaffle(address(vrf), abortFirstRequest), 0);
        vrf.fulfill(address(labx), abortFirstRequest, 0);
        assertEq(uint256(labx.getRaffle(abortFirstId).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(labx.getRaffle(abortFirstId).winner, address(0));
        assertEq(labx.activeDrawings(), 0);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.abortDrawing(abortFirstId);
    }

    function test_twoRaffleTimeoutRecoveryPreservesOtherRaffleBackingAndClaims() public {
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        uint256 cancelledId = _newRaffle(1, salesEnd);
        uint256 settledId = _newRaffle(2, salesEnd);
        _open(cancelledId);
        _open(settledId);
        _fund(usdc, alice, address(labx), 100e6);
        _fund(usdc, bob, address(labx), 100e6);
        _fund(usdc, cara, address(labx), 100e6);
        _buy(labx, alice, cancelledId);
        _buy(labx, bob, cancelledId);
        _buy(labx, cara, settledId);

        _readyAndRequest(settledId);
        vrf.fulfill(address(labx), labx.getRaffle(settledId).vrfRequestId, 0);
        _reveal(settledId, 2);
        vm.prank(outsider);
        labx.settle(settledId);
        _assertBacking(cancelledId, settledId);

        vm.warp(uint256(salesEnd) + POLICY_WINDOW);
        vm.prank(outsider);
        labx.cancel(cancelledId);
        _assertBacking(cancelledId, settledId);

        _assertRefundAdds(cancelledId, bob, 25_500_000);
        _assertBacking(cancelledId, settledId);
        vm.prank(seller);
        labx.claimProceeds(settledId);
        _assertBacking(cancelledId, settledId);
        vm.prank(outsider);
        labx.claimFee(settledId);
        _assertBacking(cancelledId, settledId);
        _assertRefundAdds(cancelledId, alice, 25_500_000);
        _assertBacking(cancelledId, settledId);

        vm.prank(bob);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.refund(cancelledId);
        vm.prank(cara);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.refund(settledId);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.NotWinner.selector);
        labx.claimPrize(settledId);
        vm.prank(cara);
        labx.claimPrize(settledId);

        assertEq(usdc.balanceOf(address(labx)), 0);
        assertEq(usdc.balanceOf(alice), 100e6);
        assertEq(usdc.balanceOf(bob), 100e6);
        assertEq(usdc.balanceOf(seller), 24_500_000);
        assertEq(usdc.balanceOf(treasury), 1e6);
        assertEq(nft.ownerOf(2), cara);
    }

    function test_stickyPrizeCannotBlockTimedBuyerRefundOrRequestCleanup() public {
        StickyERC721 sticky = new StickyERC721();
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        sticky.mint(seller, 41);
        vm.prank(seller);
        sticky.approve(address(labx), 41);
        uint256 id = _create(labx, address(sticky), 41, salesEnd);
        vm.prank(seller);
        labx.escrow(id);
        vm.prank(seller);
        labx.open(id);
        _fundAndBuy(labx, usdc, alice, id);
        _readyAndRequest(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;

        vm.warp(uint256(labx.getRaffle(id).vrfRequestedAt) + POLICY_WINDOW);
        vm.prank(outsider);
        labx.abortDrawing(id);
        _assertRefundAdds(id, alice, 25_500_000);

        assertEq(labx.requestToRaffle(address(vrf), requestId), 0);
        assertTrue(labx.requestUsed(address(vrf), requestId));
        assertEq(labx.activeDrawings(), 0);
        assertEq(labx.getRaffle(id).principalEscrow, 0);
        assertEq(labx.getRaffle(id).feeEscrow, 0);
        vm.prank(seller);
        vm.expectRevert();
        labx.reclaimPrize(id);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(sticky.ownerOf(41), address(labx));
    }

    function test_failedRefundTransferRollsBackAccountingAndCanRetry() public {
        OutboundFailERC20 failing = new OutboundFailERC20();
        LabxRaffle target = _deploy(address(failing));
        uint64 salesEnd = uint64(block.timestamp + 2 days);
        nft.mint(seller, 51);
        vm.prank(seller);
        nft.approve(address(target), 51);
        uint256 id = _create(target, address(nft), 51, salesEnd);
        vm.startPrank(seller);
        target.escrow(id);
        target.open(id);
        vm.stopPrank();
        failing.mint(alice, 100e6);
        vm.prank(alice);
        failing.approve(address(target), type(uint256).max);
        _buy(target, alice, id);

        vm.warp(uint256(salesEnd) + POLICY_WINDOW);
        vm.prank(outsider);
        target.cancel(id);
        failing.setFailTransfers(true);
        vm.prank(alice);
        vm.expectRevert();
        target.refund(id);

        assertEq(target.principalOf(id, alice), 25e6);
        assertEq(target.feeOf(id, alice), 500_000);
        assertEq(target.getRaffle(id).principalEscrow, 25e6);
        assertEq(target.getRaffle(id).feeEscrow, 500_000);
        assertEq(failing.balanceOf(address(target)), 25_500_000);
        assertEq(failing.balanceOf(alice), 74_500_000);

        failing.setFailTransfers(false);
        vm.prank(alice);
        target.refund(id);
        assertEq(target.principalOf(id, alice), 0);
        assertEq(target.feeOf(id, alice), 0);
        assertEq(failing.balanceOf(address(target)), 0);
        assertEq(failing.balanceOf(alice), 100e6);
    }

    function _deploy(address token) internal returns (LabxRaffle deployed) {
        deployed = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: token,
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(feed),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: KEY,
                subscriptionId: 1,
                termsHash: bytes32(TERMS),
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
    }

    function _configs() internal pure returns (LabxRaffle.PackConfig[] memory configs) {
        configs = new LabxRaffle.PackConfig[](1);
        configs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 25e6, bonusEntries: 1, maxSupply: 100});
    }

    function _create(LabxRaffle target, address prize, uint256 tokenId, uint64 salesEnd) internal returns (uint256 id) {
        bytes32 nonce = keccak256(abi.encodePacked("nonce", tokenId));
        bytes32 commit =
            target.hashCommitment(nonce, prize, tokenId, _publicHash(tokenId), _privateHash(tokenId), _salt(tokenId));
        vm.prank(seller);
        id = target.createRaffle(prize, tokenId, salesEnd, nonce, commit, "Recovery", _configs());
    }

    function _newRaffle(uint256 tokenId, uint64 salesEnd) internal returns (uint256 id) {
        nft.mint(seller, tokenId);
        vm.prank(seller);
        nft.approve(address(labx), tokenId);
        id = _create(labx, address(nft), tokenId, salesEnd);
    }

    function _open(uint256 id) internal {
        vm.startPrank(seller);
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
    }

    function _close(uint256 id) internal {
        uint256 end = labx.getRaffle(id).salesEnd;
        if (block.timestamp < end) vm.warp(end);
        vm.prank(seller);
        labx.close(id);
    }

    function _readyAndRequest(uint256 id) internal {
        _close(id);
        labx.snapshot(id, 300);
        vm.prank(seller);
        labx.requestRandomness(id);
    }

    function _fundAndBuy(LabxRaffle target, MockERC20 token, address buyer, uint256 id) internal {
        _fund(token, buyer, address(target), 100e6);
        _buy(target, buyer, id);
    }

    function _fund(MockERC20 token, address buyer, address spender, uint256 amount) internal {
        token.mint(buyer, amount);
        vm.prank(buyer);
        token.approve(spender, type(uint256).max);
    }

    function _buy(LabxRaffle target, address buyer, uint256 id) internal {
        vm.prank(buyer);
        target.buyPack(id, 0, 1, bytes32(TERMS));
    }

    function _assertRefundAdds(uint256 id, address buyer, uint256 amount) internal {
        uint256 before = usdc.balanceOf(buyer);
        vm.prank(buyer);
        labx.refund(id);
        assertEq(usdc.balanceOf(buyer), before + amount);
    }

    function _assertBacking(uint256 firstId, uint256 secondId) internal view {
        LabxRaffle.RaffleView memory first = labx.getRaffle(firstId);
        LabxRaffle.RaffleView memory second = labx.getRaffle(secondId);
        assertEq(
            usdc.balanceOf(address(labx)),
            first.principalEscrow + first.feeEscrow + second.principalEscrow + second.feeEscrow
        );
    }

    function _reveal(uint256 id, uint256 tokenId) internal {
        vm.prank(seller);
        labx.reveal(id, _publicHash(tokenId), _privateHash(tokenId), _salt(tokenId));
    }

    function _publicHash(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("public", tokenId));
    }

    function _privateHash(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("private", tokenId));
    }

    function _salt(uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("salt", tokenId));
    }
}
