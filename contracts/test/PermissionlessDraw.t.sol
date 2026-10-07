// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721} from "./mocks/Mocks.sol";
import {RecordingVRF} from "./BuyerProtection.t.sol";

contract PermissionlessDrawTest is Test {
    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    RecordingVRF internal vrf;
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal outsider = makeAddr("outsider");
    bytes32 internal constant TERMS = keccak256("terms");
    bytes32 internal constant KEY = keccak256("key");

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrf = new RecordingVRF();
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: makeAddr("treasury"),
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: KEY,
                subscriptionId: 1,
                termsHash: TERMS,
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
        labx.setNativePayment(true);
    }

    function _open(uint32 lots) internal returns (uint256 id) {
        nft.mint(seller, 1);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig("Entry", 1e6, 1, lots == 0 ? 1 : lots);
        vm.startPrank(seller);
        nft.approve(address(labx), 1);
        id = labx.createRaffle(
            address(nft), 1, uint64(block.timestamp + 2 days), bytes32(uint256(1)), bytes32(uint256(2)), "Piece", packs
        );
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
        usdc.mint(buyer, uint256(lots) * 6e6);
        vm.startPrank(buyer);
        usdc.approve(address(labx), type(uint256).max);
        for (uint256 i; i < lots; ++i) {
            labx.buyPack(id, 0, 1, TERMS);
        }
        vm.stopPrank();
    }

    function _close(uint256 id) internal {
        vm.warp(labx.getRaffle(id).salesEnd);
        vm.prank(outsider);
        labx.close(id);
    }

    function testFuzz_anyCallerStartsExactlyOnePinnedDraw(address caller, uint32 delay, bool paused_) public {
        uint256 id = _open(1);
        LabxRaffle.RafflePolicy memory policy = labx.getRafflePolicy(id);
        RecordingVRF replacement = new RecordingVRF();
        labx.setVrfConfig(keccak256("changed"), 2, 600_000, 5);
        labx.setNativePayment(false);
        labx.proposeCoordinator(address(replacement));
        vm.warp(block.timestamp + 1 days);
        labx.applyCoordinator();
        _close(id);
        labx.snapshot(id, 1);
        vm.warp(uint256(labx.getRaffle(id).salesEnd) + bound(delay, 0, 7 days - 1));
        labx.setPaused(paused_);
        vm.prank(caller);
        labx.requestRandomness(id);
        LabxRaffle.RaffleView memory drawing = labx.getRaffle(id);
        assertEq(uint256(drawing.phase), uint256(LabxRaffle.Phase.Drawing));
        assertEq(drawing.vrfRequestedAt, block.timestamp);
        assertEq(labx.requestToRaffle(address(vrf), drawing.vrfRequestId), id);
        assertEq(vrf.requestedKey(), policy.keyHash);
        assertEq(vrf.requestedSubscription(), policy.subscriptionId);
        assertEq(vrf.requestedGas(), policy.callbackGasLimit);
        assertEq(vrf.requestedConfirmations(), policy.requestConfirmations);
        assertTrue(vrf.lastNativePayment());
        assertEq(replacement.next(), 1);
        assertEq(vrf.next(), 2);
        assertEq(labx.activeDrawings(), 1);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        assertEq(vrf.next(), 2);
        vrf.fulfill(address(labx), drawing.vrfRequestId, 0);
        assertEq(labx.getRaffle(id).winner, buyer);
        vm.prank(caller);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        assertEq(vrf.next(), 2);
    }

    function test_buyerCanStartDrawAtLastSecond() public {
        uint256 id = _open(1);
        _close(id);
        labx.snapshot(id, 1);
        vm.warp(uint256(labx.getRaffle(id).salesEnd) + 7 days - 1);
        vm.prank(buyer);
        labx.requestRandomness(id);
        assertEq(labx.getRaffle(id).vrfRequestedAt, block.timestamp);
    }

    function test_outsiderCannotStartEarlyOrWithIncompleteSnapshot() public {
        uint256 id = _open(2);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.TooEarly.selector);
        labx.close(id);
        _close(id);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        labx.snapshot(id, 1);
        assertEq(labx.getRaffle(id).snapshotTotal, 1);
        assertFalse(labx.getRaffle(id).snapshotted);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        assertEq(vrf.next(), 1);
    }

    function test_outsiderCannotStartEmptySnapshot() public {
        uint256 id = _open(0);
        _close(id);
        labx.snapshot(id, 1);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.EmptyDraw.selector);
        labx.requestRandomness(id);
        assertEq(vrf.next(), 1);
    }

    function testFuzz_exactCutoffPreservesPermissionlessRefund(uint8 callerRole, bool paused_) public {
        uint256 id = _open(1);
        _close(id);
        labx.snapshot(id, 1);
        labx.setPaused(paused_);
        vm.warp(uint256(labx.getRaffle(id).salesEnd) + 7 days);
        address caller =
            callerRole % 4 == 0 ? seller : callerRole % 4 == 1 ? address(this) : callerRole % 4 == 2 ? buyer : outsider;
        vm.prank(caller);
        vm.expectRevert(LabxRaffle.Expired.selector);
        labx.requestRandomness(id);
        assertEq(vrf.next(), 1);
        vm.prank(outsider);
        labx.cancel(id);
        vm.prank(buyer);
        labx.refund(id);
        assertEq(usdc.balanceOf(buyer), 6e6);
        assertEq(usdc.balanceOf(address(labx)), 0);
    }

    function test_permissionlessRequestDoesNotGrantOtherPrivileges() public {
        uint256 id = _open(1);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        labx.setPaused(true);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotSeller.selector);
        labx.reveal(id, bytes32(0), bytes32(0), bytes32(0));
        _close(id);
        labx.snapshot(id, 1);
        vm.prank(outsider);
        labx.requestRandomness(id);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        labx.retryRandomness(id);
        vm.expectRevert(LabxRaffle.RandomnessRetryDisabled.selector);
        labx.retryRandomness(id);
        assertEq(labx.DRAW_START_GRACE(), 7 days);
        assertEq(labx.VRF_ABORT_AFTER(), 7 days);
        assertEq(labx.REVEAL_GRACE(), 7 days);
    }

    function test_completedMaximumSnapshotHasColdStorageGasMargin() public {
        uint256 id = _open(300);
        _close(id);
        vm.cool(address(labx));
        uint256 beforeGas = gasleft();
        labx.snapshot(id, 300);
        uint256 measured = beforeGas - gasleft();
        emit log_named_uint("cold_completed_snapshot_300_external_call_gas", measured);
        assertLt(measured + 22_088, 15_000_000);
        assertTrue(labx.getRaffle(id).snapshotted);
        assertEq(labx.getRaffle(id).snapshotTotal, 300);
    }

    function test_snapshotCapHasColdStorageGasMarginAndResumes() public {
        uint256 id = _open(301);
        _close(id);
        for (uint256 steps = 301; steps <= 500; steps += 199) {
            vm.expectRevert(LabxRaffle.BadConfig.selector);
            labx.snapshot(id, steps);
            assertEq(labx.getRaffle(id).lotCursor, 0);
        }
        vm.expectRevert(LabxRaffle.BadConfig.selector);
        labx.snapshot(id, 0);
        vm.cool(address(labx));
        uint256 beforeGas = gasleft();
        labx.snapshot(id, 300);
        uint256 measured = beforeGas - gasleft();
        emit log_named_uint("cold_snapshot_300_external_call_gas", measured);
        // 22,088 covers 21,000 intrinsic gas plus 68 bytes at the maximum calldata byte cost.
        assertLt(measured + 22_088, 15_000_000);
        assertEq(labx.getRaffle(id).lotCursor, 300);
        assertEq(labx.getRaffle(id).snapshotTotal, 300);
        assertFalse(labx.getRaffle(id).snapshotted);
        assertEq(labx.cumulatives(id, 299), 300);
        assertEq(labx.snapshotOwners(id, 299), buyer);
        vm.prank(outsider);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
        labx.snapshot(id, 1);
        assertTrue(labx.getRaffle(id).snapshotted);
        assertEq(labx.cumulatives(id, 300), 301);
        vm.prank(outsider);
        labx.requestRandomness(id);
    }
}
