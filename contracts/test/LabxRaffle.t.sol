// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {
    MockERC20,
    MockERC721,
    MaliciousERC721,
    MockFeed,
    MockWETH,
    MockRouter,
    MockVRF,
    RevertingReceiver,
    StickyERC721,
    SyncVRF
} from "./mocks/Mocks.sol";

contract LabxRaffleTest is Test {
    uint256 internal constant TERMS = uint256(keccak256("terms-v1"));
    bytes32 internal constant KEY = keccak256("key");

    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockFeed internal feed;
    MockWETH internal weth;
    MockRouter internal router;
    MockVRF internal vrf;

    address internal treasury = makeAddr("treasury");
    address internal signer;
    uint256 internal signerKey = 0xA11CE;
    address internal seller = makeAddr("seller");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal cara = makeAddr("cara");

    function setUp() public {
        signer = vm.addr(signerKey);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        feed = new MockFeed();
        weth = new MockWETH();
        router = new MockRouter(weth, usdc);
        vrf = new MockVRF();
        labx = _deploy(address(usdc));
        nft.mint(seller, 1);
        vm.prank(seller);
        nft.approve(address(labx), 1);
    }

    function _deploy(address usdc_) internal returns (LabxRaffle deployed) {
        deployed = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: usdc_,
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(feed),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: KEY,
                subscriptionId: 1,
                amoeSigner: signer,
                termsHash: bytes32(TERMS),
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                amoeCap: 0
            })
        );
    }

    function _deadline() internal view returns (uint256) {
        return block.timestamp + 5 minutes;
    }

    function _pullSettled(uint256 id, address winner) internal {
        vm.prank(winner);
        labx.claimPrize(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        labx.claimFee(id);
    }

    function _pack(string memory name, uint128 price, uint32 entries, uint32 supply)
        internal
        pure
        returns (LabxRaffle.PackConfig memory)
    {
        return LabxRaffle.PackConfig({name: name, priceUsdc: price, bonusEntries: entries, maxSupply: supply});
    }

    function _configs() internal pure returns (LabxRaffle.PackConfig[] memory configs) {
        configs = new LabxRaffle.PackConfig[](5);
        configs[0] = _pack("Entry", 25e6, 1, 100);
        configs[1] = _pack("Bronze", 50e6, 5, 50);
        configs[2] = _pack("Silver", 100e6, 15, 30);
        configs[3] = _pack("Gold", 250e6, 40, 20);
        configs[4] = _pack("Platinum", 500e6, 100, 10);
    }

    function _commit(bytes32 nonce, bytes32 publicHash, bytes32 privateHash, bytes32 salt) internal view returns (bytes32) {
        return labx.hashCommitment(nonce, address(nft), 1, publicHash, privateHash, salt);
    }

    function _create() internal returns (uint256 id, bytes32 publicHash, bytes32 privateHash, bytes32 salt) {
        bytes32 nonce = bytes32(uint256(7));
        publicHash = keccak256("public-summary");
        privateHash = keccak256("private-commitment");
        salt = bytes32(uint256(9));
        bytes32 commit = _commit(nonce, publicHash, privateHash, salt);
        vm.prank(seller);
        id = labx.createRaffle(address(nft), 1, uint64(block.timestamp + 2 days), nonce, commit, "Junction Array", _configs());
    }

    function _escrowOpen(uint256 id) internal {
        vm.prank(seller);
        labx.escrow(id);
        vm.prank(seller);
        labx.open(id);
    }

    function _fund(address buyer, uint256 amount) internal {
        usdc.mint(buyer, amount);
        vm.prank(buyer);
        usdc.approve(address(labx), type(uint256).max);
    }

    function _buy(address buyer, uint256 id, uint8 packId, uint32 qty) internal {
        vm.prank(buyer);
        labx.buyPack(id, packId, qty, bytes32(TERMS));
    }

    function test_constructor_revertsOnMainnet() public {
        vm.chainId(1);
        vm.expectRevert(LabxRaffle.MainnetDisabled.selector);
        _deploy(address(usdc));
    }

    function test_constructor_revertsWhenUsdcIsNotSixDecimals() public {
        MockERC20 wrong = new MockERC20("Wrong", "W", 18);
        vm.expectRevert(LabxRaffle.UsdcDecimals.selector);
        _deploy(address(wrong));
    }

    function test_happyPath_weightedWinner_feeAndEscrow() public {
        (uint256 id, bytes32 publicHash, bytes32 privateHash, bytes32 salt) = _create();
        _escrowOpen(id);

        _fund(alice, 1_000e6);
        _fund(bob, 1_000e6);
        _fund(cara, 1_000e6);
        _buy(alice, id, 0, 1); // 25 + 5, 1 entry
        _buy(bob, id, 0, 1); // 1 entry
        _buy(cara, id, 1, 1); // 50 + 5, 5 entries

        assertEq(labx.principalOf(id, alice), 25e6);
        assertEq(labx.feeOf(id, alice), 5e6);
        LabxRaffle.RaffleView memory viewR = labx.getRaffle(id);
        assertEq(viewR.principalEscrow, 100e6);
        assertEq(viewR.feeEscrow, 15e6);
        assertEq(nft.ownerOf(1), address(labx));

        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 50);
        viewR = labx.getRaffle(id);
        assertTrue(viewR.snapshotted);
        assertEq(viewR.snapshotTotal, 7);

        vm.prank(seller);
        labx.requestRandomness(id);
        viewR = labx.getRaffle(id);
        // word % 7 == 6 selects the third lot (5 entries)
        vrf.fulfill(address(labx), viewR.vrfRequestId, 6);
        viewR = labx.getRaffle(id);
        assertEq(viewR.winner, cara);
        assertEq(uint256(viewR.phase), uint256(LabxRaffle.Phase.Drawn));

        vm.prank(seller);
        labx.reveal(id, publicHash, privateHash, salt);
        labx.settle(id);
        assertEq(nft.ownerOf(1), address(labx));
        assertEq(usdc.balanceOf(seller), 0);
        _pullSettled(id, cara);

        assertEq(nft.ownerOf(1), cara);
        assertEq(usdc.balanceOf(seller), 100e6);
        assertEq(usdc.balanceOf(treasury), 15e6);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Settled));
    }

    function test_winnerBoundaries() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _fund(bob, 100e6);
        _fund(cara, 100e6);
        _buy(alice, id, 0, 1);
        _buy(bob, id, 0, 1);
        _buy(cara, id, 1, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 10);
        vm.prank(seller);
        labx.requestRandomness(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;

        // Fresh draws need fresh raffles because a request fulfills once.
        // Boundaries are checked against the same cumulative table via a second and third raffle below.
        vrf.fulfill(address(labx), requestId, 0);
        assertEq(labx.getRaffle(id).winner, alice);
    }

    function test_secondAndThirdWeightBands() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _fund(bob, 100e6);
        _fund(cara, 200e6);
        _buy(alice, id, 0, 1);
        _buy(bob, id, 0, 1);
        _buy(cara, id, 1, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 10);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 1);
        assertEq(labx.getRaffle(id).winner, bob);
    }

    function test_weightBandForLargeLot() public {
        nft.mint(seller, 2);
        vm.prank(seller);
        nft.approve(address(labx), 2);
        bytes32 nonce = bytes32(uint256(8));
        bytes32 publicHash = keccak256("p");
        bytes32 privateHash = keccak256("q");
        bytes32 salt = bytes32(uint256(3));
        bytes32 commit = labx.hashCommitment(nonce, address(nft), 2, publicHash, privateHash, salt);
        vm.prank(seller);
        uint256 id = labx.createRaffle(address(nft), 2, uint64(block.timestamp + 2 days), nonce, commit, "Port Cluster", _configs());
        vm.startPrank(seller);
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
        _fund(alice, 100e6);
        _fund(bob, 100e6);
        _fund(cara, 200e6);
        _buy(alice, id, 0, 1);
        _buy(bob, id, 0, 1);
        _buy(cara, id, 1, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 10);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 6);
        assertEq(labx.getRaffle(id).winner, cara);
    }

    function test_entriesAfterCloseAreExcluded() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _fund(bob, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.SalesClosed.selector);
        labx.buyPack(id, 0, 1, bytes32(TERMS));
        labx.snapshot(id, 10);
        assertEq(labx.getRaffle(id).snapshotTotal, 1);
    }

    function test_expiredLotsDropOutOfSnapshot() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.warp(block.timestamp + 366 days);
        labx.close(id);
        labx.snapshot(id, 10);
        LabxRaffle.RaffleView memory v = labx.getRaffle(id);
        assertTrue(v.snapshotted);
        assertEq(v.snapshotTotal, 0);
        vm.prank(seller);
        labx.cancel(id);
        assertEq(nft.ownerOf(1), address(labx));
        vm.prank(seller);
        labx.reclaimPrize(id);
        assertEq(nft.ownerOf(1), seller);
    }

    function test_ethPurchaseSwapsAndRefundsSurplus() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        vm.deal(alice, 1 ether);
        uint256 total = 30e6; // 25 + 5
        uint256 quoted = labx.quoteEthForUsdc(total);
        assertEq(quoted, 0.015 ether);
        vm.prank(alice);
        labx.buyPackWithEth{value: 0.02 ether}(id, 0, 1, bytes32(TERMS), 200, _deadline());
        assertEq(labx.principalOf(id, alice), 25e6);
        assertEq(labx.feeOf(id, alice), 5e6);
        assertEq(usdc.balanceOf(address(labx)), 30e6);
        uint256 cap = (quoted * 10_200 + 9_999) / 10_000;
        assertEq(alice.balance, 1 ether - (cap / 2));
        assertEq(address(labx).balance, 0);
    }

    function test_ethRevertsWhenOracleStaleOrValueShort() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        vm.deal(alice, 1 ether);
        feed.setUpdatedAt(1);
        vm.warp(4 hours);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.StalePrice.selector);
        labx.buyPackWithEth{value: 1 ether}(id, 0, 1, bytes32(TERMS), 100, _deadline());
        feed.setUpdatedAt(block.timestamp);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.InsufficientEth.selector);
        labx.buyPackWithEth{value: 0.001 ether}(id, 0, 1, bytes32(TERMS), 0, _deadline());
    }

    function test_amoeOneEntryAndRejectsReplay() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        bytes32 captcha = keccak256("captcha");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = labx.hashAmoe(id, alice, captcha, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        vm.prank(alice);
        labx.claimAmoe(id, captcha, deadline, sig);
        assertEq(labx.lotCount(id), 1);
        assertTrue(labx.amoeClaimed(id, alice));
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.CaptchaUsed.selector);
        labx.claimAmoe(id, captcha, deadline, sig);
        bytes32 second = keccak256("captcha-2");
        bytes32 digest2 = labx.hashAmoe(id, alice, second, deadline);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(signerKey, digest2);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.AmoeUsed.selector);
        labx.claimAmoe(id, second, deadline, abi.encodePacked(r2, s2, v2));
    }

    function test_amoeRejectsUnknownSigner() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        bytes32 captcha = keccak256("captcha");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 bobDigest = labx.hashAmoe(id, bob, captcha, deadline);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(uint256(0xBEEF), bobDigest);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.BadSignature.selector);
        labx.claimAmoe(id, captcha, deadline, abi.encodePacked(r2, s2, v2));
    }

    function test_termsMustMatch() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.TermsMismatch.selector);
        labx.buyPack(id, 0, 1, bytes32(uint256(1)));
    }

    function test_cancelRefundsPrincipalAndFee() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        uint256 before = usdc.balanceOf(alice);
        labx.cancel(id);
        vm.prank(alice);
        labx.refund(id);
        assertEq(usdc.balanceOf(alice), before + 30e6);
        assertEq(labx.getRaffle(id).principalEscrow, 0);
        assertEq(labx.getRaffle(id).feeEscrow, 0);
        assertEq(nft.ownerOf(1), address(labx));
        vm.prank(seller);
        labx.reclaimPrize(id);
        assertEq(nft.ownerOf(1), seller);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.refund(id);
    }

    function test_sellerCannotCancelAfterSales() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.SalesStarted.selector);
        labx.cancel(id);
    }

    function test_revealMismatchAndSettleGrace() public {
        (uint256 id, bytes32 publicHash, bytes32 privateHash,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 1);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.RevealMismatch.selector);
        labx.reveal(id, publicHash, privateHash, bytes32(uint256(123)));
        vm.expectRevert(LabxRaffle.RevealRequired.selector);
        labx.settle(id);
        vm.warp(block.timestamp + 7 days);
        labx.settle(id);
        assertEq(nft.ownerOf(1), address(labx));
        _pullSettled(id, alice);
        assertEq(nft.ownerOf(1), alice);
        assertEq(usdc.balanceOf(treasury), 5e6);
    }

    function test_snapshotAndVrfOrdering() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.snapshot(id, 10);
        vm.prank(seller);
        labx.close(id);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.requestRandomness(id);
    }

    function test_onlyCoordinatorFulfills() public {
        uint256[] memory words = new uint256[](1);
        words[0] = 1;
        labx.rawFulfillRandomWords(1, words);

        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;
        vm.expectRevert(abi.encodeWithSelector(LabxRaffle.OnlyCoordinator.selector, address(this), address(vrf)));
        labx.rawFulfillRandomWords(requestId, words);
        vm.expectRevert(LabxRaffle.DrawInFlight.selector);
        labx.proposeCoordinator(makeAddr("replacement"));
    }

    function test_pauseBlocksPurchase() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        labx.setPaused(true);
        _fund(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.Paused.selector);
        labx.buyPack(id, 0, 1, bytes32(TERMS));
    }

    function test_soldOutAndOpenRequiresEscrow() public {
        (uint256 id,,,) = _create();
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.EscrowMissing.selector);
        labx.open(id);
        _escrowOpen(id);
        _fund(alice, 10_000e6);
        // Entry pack supply in this helper is 100, buy MAX is 20. Use a tiny custom raffle.
        nft.mint(seller, 3);
        vm.prank(seller);
        nft.approve(address(labx), 3);
        LabxRaffle.PackConfig[] memory one = new LabxRaffle.PackConfig[](1);
        one[0] = _pack("Entry", 25e6, 1, 1);
        bytes32 nonce = keccak256("n");
        bytes32 commit = labx.hashCommitment(nonce, address(nft), 3, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id2 = labx.createRaffle(address(nft), 3, uint64(block.timestamp + 1 days), nonce, commit, "Cable Run", one);
        vm.startPrank(seller);
        labx.escrow(id2);
        labx.open(id2);
        vm.stopPrank();
        _buy(alice, id2, 0, 1);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.SoldOut.selector);
        labx.buyPack(id2, 0, 1, bytes32(TERMS));
    }

    function test_reentrancyOnEscrowIsRejected() public {
        MaliciousERC721 bad = new MaliciousERC721();
        bad.mint(seller, 9);
        vm.prank(seller);
        bad.approve(address(labx), 9);
        bytes32 nonce = keccak256("mal");
        bytes32 commit = labx.hashCommitment(nonce, address(bad), 9, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id = labx.createRaffle(address(bad), 9, uint64(block.timestamp + 1 days), nonce, commit, "Hostile Port", _configs());
        bad.setTarget(address(labx));
        _fund(seller, 100e6);
        vm.prank(seller);
        vm.expectRevert();
        labx.escrow(id);
        assertFalse(labx.getRaffle(id).escrowed);
    }

    function test_directEthIsRejected() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(labx).call{value: 1 ether}("");
        assertFalse(ok);
    }

    function test_ownershipIsTwoStep() public {
        labx.transferOwnership(treasury);
        assertEq(labx.pendingOwner(), treasury);
        assertEq(labx.owner(), address(this));
        vm.prank(treasury);
        labx.acceptOwnership();
        assertEq(labx.owner(), treasury);
    }

    function test_nonSellerCannotOpen() public {
        (uint256 id,,,) = _create();
        vm.prank(seller);
        labx.escrow(id);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.NotSeller.selector);
        labx.open(id);
    }

    function test_chunkedSnapshotMatchesSinglePass() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 1_000e6);
        _buy(alice, id, 0, 1);
        _buy(alice, id, 0, 1);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 1);
        assertFalse(labx.getRaffle(id).snapshotted);
        labx.snapshot(id, 1);
        labx.snapshot(id, 10);
        assertTrue(labx.getRaffle(id).snapshotted);
        assertEq(labx.getRaffle(id).snapshotTotal, 3);
    }

    function testFuzz_qtyCreditsExactFee(uint32 qty) public {
        qty = uint32(bound(qty, 1, 20));
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 20_000e6);
        _buy(alice, id, 0, qty);
        assertEq(labx.feeOf(id, alice), uint256(qty) * 5e6);
        assertEq(labx.principalOf(id, alice), uint256(qty) * 25e6);
        assertEq(labx.lotAt(id, 0).amount, qty);
        assertEq(labx.lotAt(id, 0).expiresAt, uint64(block.timestamp + 365 days));
    }

    function test_revertingReceiverCannotFreezeUsdc() public {
        (uint256 id, bytes32 publicHash, bytes32 privateHash, bytes32 salt) = _create();
        _escrowOpen(id);
        RevertingReceiver recv = new RevertingReceiver();
        _fund(address(recv), 100e6);
        vm.prank(address(recv));
        labx.buyPack(id, 0, 1, bytes32(TERMS));
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);
        vm.prank(seller);
        labx.reveal(id, publicHash, privateHash, salt);
        labx.settle(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        labx.claimFee(id);
        assertEq(usdc.balanceOf(seller), 25e6);
        assertEq(usdc.balanceOf(treasury), 5e6);
        vm.prank(address(recv));
        labx.claimPrize(id);
        assertEq(nft.ownerOf(1), address(recv));
    }

    function test_stickyNftBlocksClaimButNotUsdc() public {
        StickyERC721 sticky = new StickyERC721();
        sticky.mint(seller, 11);
        vm.prank(seller);
        sticky.approve(address(labx), 11);
        bytes32 nonce = keccak256("sticky");
        bytes32 publicHash = keccak256("sp");
        bytes32 privateHash = keccak256("sq");
        bytes32 salt = keccak256("ss");
        bytes32 commit = labx.hashCommitment(nonce, address(sticky), 11, publicHash, privateHash, salt);
        vm.prank(seller);
        uint256 id = labx.createRaffle(
            address(sticky), 11, uint64(block.timestamp + 2 days), nonce, commit, "Sticky Port", _configs()
        );
        vm.startPrank(seller);
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);
        vm.prank(seller);
        labx.reveal(id, publicHash, privateHash, salt);
        labx.settle(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        labx.claimFee(id);
        assertEq(usdc.balanceOf(seller), 25e6);
        assertEq(usdc.balanceOf(treasury), 5e6);
        vm.prank(alice);
        vm.expectRevert(bytes("sticky"));
        labx.claimPrize(id);
        assertEq(sticky.ownerOf(11), address(labx));
    }

    function test_stickyNftCancelStillRefunds() public {
        StickyERC721 sticky = new StickyERC721();
        sticky.mint(seller, 12);
        vm.prank(seller);
        sticky.approve(address(labx), 12);
        bytes32 nonce = keccak256("sticky-cancel");
        bytes32 commit = labx.hashCommitment(nonce, address(sticky), 12, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id = labx.createRaffle(
            address(sticky), 12, uint64(block.timestamp + 2 days), nonce, commit, "Sticky Cancel", _configs()
        );
        vm.startPrank(seller);
        labx.escrow(id);
        labx.open(id);
        vm.stopPrank();
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        uint256 before = usdc.balanceOf(alice);
        labx.cancel(id);
        vm.prank(alice);
        labx.refund(id);
        assertEq(usdc.balanceOf(alice), before + 30e6);
        vm.prank(seller);
        vm.expectRevert(bytes("sticky"));
        labx.reclaimPrize(id);
        assertEq(sticky.ownerOf(12), address(labx));
    }

    function test_ethSpendIsCappedAtQuotePlusSlippage() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        router.setSpend(1, 1);
        vm.deal(alice, 1 ether);
        uint256 quoted = labx.quoteEthForUsdc(30e6);
        vm.prank(alice);
        labx.buyPackWithEth{value: 1 ether}(id, 0, 1, bytes32(TERMS), 0, _deadline());
        assertEq(alice.balance, 1 ether - quoted);
        assertEq(usdc.balanceOf(address(labx)), 30e6);
    }

    function test_ethRejectsMissingOrDistantDeadline() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadDeadline.selector);
        labx.buyPackWithEth{value: 1 ether}(id, 0, 1, bytes32(TERMS), 0, 0);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.BadDeadline.selector);
        labx.buyPackWithEth{value: 1 ether}(id, 0, 1, bytes32(TERMS), 0, block.timestamp + 11 minutes);
    }

    function test_ethPathDisabledByOwner() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        labx.setEthPathEnabled(false);
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        vm.expectRevert(LabxRaffle.EthPathDisabled.selector);
        labx.buyPackWithEth{value: 1 ether}(id, 0, 1, bytes32(TERMS), 0, _deadline());
        labx.setEthPathEnabled(true);
        assertTrue(labx.ethPathEnabled());
    }

    function test_coordinatorTimelockAndPin() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);
        assertEq(labx.activeDrawings(), 0);
        address next = makeAddr("next-coordinator");
        labx.proposeCoordinator(next);
        vm.expectRevert(LabxRaffle.TooEarly.selector);
        labx.applyCoordinator();
        vm.warp(block.timestamp + 1 days);
        labx.applyCoordinator();
        assertEq(labx.vrfCoordinator(), next);
    }

    function test_syncCallbackIsAppliedAfterRequestIsPinned() public {
        SyncVRF sync = new SyncVRF();
        LabxRaffle pinned = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 3000,
                vrfCoordinator: address(sync),
                keyHash: KEY,
                subscriptionId: 1,
                amoeSigner: signer,
                termsHash: bytes32(TERMS),
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                amoeCap: 1
            })
        );
        nft.mint(seller, 21);
        vm.prank(seller);
        nft.approve(address(pinned), 21);
        bytes32 nonce = keccak256("sync");
        bytes32 commit = pinned.hashCommitment(nonce, address(nft), 21, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id = pinned.createRaffle(
            address(nft), 21, uint64(block.timestamp + 2 days), nonce, commit, "Sync Draw", _configs()
        );
        vm.startPrank(seller);
        pinned.escrow(id);
        pinned.open(id);
        vm.stopPrank();
        usdc.mint(alice, 100e6);
        vm.prank(alice);
        usdc.approve(address(pinned), type(uint256).max);
        vm.prank(alice);
        pinned.buyPack(id, 0, 1, bytes32(TERMS));
        vm.prank(seller);
        pinned.close(id);
        pinned.snapshot(id, 5);
        vm.prank(seller);
        pinned.requestRandomness(id);
        assertEq(uint256(pinned.getRaffle(id).phase), uint256(LabxRaffle.Phase.Drawn));
        assertEq(pinned.getRaffle(id).winner, alice);
        assertEq(pinned.activeDrawings(), 0);
        assertEq(pinned.requestCoordinator(77), address(sync));
        assertFalse(pinned.ethPathEnabled());
    }

    function test_amoeCapAndCaptchaAreSingleUse() public {
        LabxRaffle capped = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasury,
                usdc: address(usdc),
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(feed),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: KEY,
                subscriptionId: 1,
                amoeSigner: signer,
                termsHash: bytes32(TERMS),
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                amoeCap: 1
            })
        );
        nft.mint(seller, 22);
        vm.prank(seller);
        nft.approve(address(capped), 22);
        bytes32 nonce = keccak256("amoe-cap");
        bytes32 commit = capped.hashCommitment(nonce, address(nft), 22, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id = capped.createRaffle(
            address(nft), 22, uint64(block.timestamp + 2 days), nonce, commit, "Amoe Cap", _configs()
        );
        vm.startPrank(seller);
        capped.escrow(id);
        capped.open(id);
        vm.stopPrank();

        bytes32 captcha = keccak256("once");
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = capped.hashAmoe(id, alice, captcha, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        vm.prank(alice);
        capped.claimAmoe(id, captcha, deadline, abi.encodePacked(r, s, v));
        assertEq(capped.getRaffle(id).amoeCount, 1);

        bytes32 again = keccak256("twice");
        bytes32 bobDigest = capped.hashAmoe(id, bob, again, deadline);
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(signerKey, bobDigest);
        vm.prank(bob);
        vm.expectRevert(LabxRaffle.AmoeCap.selector);
        capped.claimAmoe(id, again, deadline, abi.encodePacked(r2, s2, v2));

        vm.prank(bob);
        vm.expectRevert(LabxRaffle.CaptchaUsed.selector);
        capped.claimAmoe(id, captcha, deadline, abi.encodePacked(r, s, v));

        vm.prank(bob);
        vm.expectRevert(LabxRaffle.CaptchaUsed.selector);
        capped.claimAmoe(id, bytes32(0), deadline, abi.encodePacked(r2, s2, v2));
    }

    function test_abortDrawingLeavesNftForSellerPull() public {
        (uint256 id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
        vm.prank(seller);
        labx.requestRandomness(id);
        vm.warp(block.timestamp + 1 days);
        labx.abortDrawing(id);
        assertEq(labx.activeDrawings(), 0);
        assertEq(nft.ownerOf(1), address(labx));
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        labx.refund(id);
        assertEq(usdc.balanceOf(alice), before + 30e6);
        vm.prank(seller);
        labx.reclaimPrize(id);
        assertEq(nft.ownerOf(1), seller);
    }

    function _drawReady() internal returns (uint256 id) {
        (id,,,) = _create();
        _escrowOpen(id);
        _fund(alice, 100e6);
        _buy(alice, id, 0, 1);
        vm.prank(seller);
        labx.close(id);
        labx.snapshot(id, 5);
    }

    function test_setVrfConfigRevertsWhenDrawInFlight() public {
        uint256 id = _drawReady();
        labx.setVrfConfig(KEY, 2, 500_000, 3);
        assertEq(labx.subscriptionId(), 2);

        vm.prank(seller);
        labx.requestRandomness(id);
        vm.expectRevert(LabxRaffle.DrawInFlight.selector);
        labx.setVrfConfig(KEY, 3, 500_000, 3);

        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);
        labx.setVrfConfig(KEY, 4, 400_000, 5);
        assertEq(labx.subscriptionId(), 4);
        assertEq(labx.callbackGasLimit(), 400_000);
        assertEq(labx.requestConfirmations(), 5);
    }

    function test_abortDrawingClearsRequestMap() public {
        uint256 id = _drawReady();
        vm.prank(seller);
        labx.requestRandomness(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;
        assertEq(labx.requestToRaffle(requestId), id);
        assertEq(labx.requestCoordinator(requestId), address(vrf));

        vm.warp(block.timestamp + 1 days);
        labx.abortDrawing(id);
        assertEq(labx.requestToRaffle(requestId), 0);
        assertEq(labx.requestCoordinator(requestId), address(0));
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Cancelled));

        vrf.fulfill(address(labx), requestId, 0);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(labx.getRaffle(id).winner, address(0));
        assertEq(labx.activeDrawings(), 0);
    }

    function test_retryRandomnessReplacesFailedRequest() public {
        uint256 id = _drawReady();
        vm.prank(seller);
        labx.requestRandomness(id);
        uint256 oldId = labx.getRaffle(id).vrfRequestId;
        assertEq(labx.activeDrawings(), 1);

        labx.retryRandomness(id);
        uint256 newId = labx.getRaffle(id).vrfRequestId;
        assertTrue(newId != oldId);
        assertEq(labx.requestToRaffle(oldId), 0);
        assertEq(labx.requestCoordinator(oldId), address(0));
        assertEq(labx.requestToRaffle(newId), id);
        assertEq(labx.requestCoordinator(newId), address(vrf));
        assertEq(labx.activeDrawings(), 1);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Drawing));

        vrf.fulfill(address(labx), oldId, 0);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Drawing));
        assertEq(labx.getRaffle(id).winner, address(0));

        vrf.fulfill(address(labx), newId, 0);
        assertEq(uint256(labx.getRaffle(id).phase), uint256(LabxRaffle.Phase.Drawn));
        assertEq(labx.getRaffle(id).winner, alice);
        assertEq(labx.activeDrawings(), 0);
    }

    function test_retryRandomnessRevertsWhenNotDrawing() public {
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.retryRandomness(1);

        uint256 id = _drawReady();
        vm.expectRevert(LabxRaffle.BadPhase.selector);
        labx.retryRandomness(id);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        labx.retryRandomness(id);
    }

    function test_nativePaymentTogglesWhenNoActiveDrawings() public {
        assertFalse(labx.nativePayment());
        assertFalse(vrf.lastNativePayment());

        uint256 id = _drawReady();
        vm.prank(seller);
        labx.requestRandomness(id);
        assertFalse(vrf.lastNativePayment());

        vm.expectRevert(LabxRaffle.DrawInFlight.selector);
        labx.setNativePayment(true);

        vrf.fulfill(address(labx), labx.getRaffle(id).vrfRequestId, 0);
        assertEq(labx.activeDrawings(), 0);

        labx.setNativePayment(true);
        assertTrue(labx.nativePayment());

        nft.mint(seller, 31);
        vm.prank(seller);
        nft.approve(address(labx), 31);
        bytes32 nonce = keccak256("native-pay");
        bytes32 commit = labx.hashCommitment(nonce, address(nft), 31, keccak256("a"), keccak256("b"), keccak256("c"));
        vm.prank(seller);
        uint256 id2 = labx.createRaffle(
            address(nft), 31, uint64(block.timestamp + 2 days), nonce, commit, "Native Pay", _configs()
        );
        vm.startPrank(seller);
        labx.escrow(id2);
        labx.open(id2);
        vm.stopPrank();
        _fund(bob, 100e6);
        _buy(bob, id2, 0, 1);
        vm.prank(seller);
        labx.close(id2);
        labx.snapshot(id2, 5);
        vm.prank(seller);
        labx.requestRandomness(id2);
        assertTrue(vrf.lastNativePayment());

        vrf.fulfill(address(labx), labx.getRaffle(id2).vrfRequestId, 0);
        labx.setNativePayment(false);
        assertFalse(labx.nativePayment());
    }

    function test_adminSettersEmitEvents() public {
        address nextTreasury = makeAddr("next-treasury");
        address nextSigner = makeAddr("next-signer");
        vm.expectEmit(true, true, false, true);
        emit LabxRaffle.TreasurySet(treasury, nextTreasury);
        labx.setTreasury(nextTreasury);
        assertEq(labx.treasury(), nextTreasury);

        vm.expectEmit(true, true, false, true);
        emit LabxRaffle.AmoeSignerSet(signer, nextSigner);
        labx.setAmoeSigner(nextSigner);
        assertEq(labx.amoeSigner(), nextSigner);

        vm.expectEmit(false, false, false, true);
        emit LabxRaffle.VrfConfigSet(keccak256("k2"), 9, 600_000, 4);
        labx.setVrfConfig(keccak256("k2"), 9, 600_000, 4);

        vm.expectEmit(false, false, false, true);
        emit LabxRaffle.NativePaymentSet(true);
        labx.setNativePayment(true);
    }
}
