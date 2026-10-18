// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC721} from "./mocks/Mocks.sol";
import {CreateMainnetSubscription, DeployMainnet, MainnetDeployment} from "../script/DeployMainnet.s.sol";

interface ICoordinatorView {
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] memory consumers);
    function createSubscription() external returns (uint256 subId);
    function acceptSubscriptionOwnerTransfer(uint256 subId) external;
}

interface IUsdc {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract CreateMainnetSubscriptionHarness is CreateMainnetSubscription {
    function create(uint256 pk) external {
        _create(pk);
    }
}

contract DeployMainnetHarness is DeployMainnet {
    function deploy(Config memory c) external returns (LabxRaffle) {
        return _deploy(c);
    }

    function validateSafe(address safe) external view {
        _validateSafe(safe);
    }

    function validateCallbackGas(uint256 callbackGas) external pure {
        _validateCallbackGas(callbackGas);
    }
}

/// @notice Refusals that happen before anything is broadcast. They need no fork and read no environment variables,
///         which other test contracts running in parallel also set.
contract DeployMainnetRefusalTest is Test {
    address internal safe = makeAddr("mainnet-safe-fixture");
    DeployMainnetHarness internal script = new DeployMainnetHarness();

    function test_refusesEveryChainButMainnet() public {
        vm.chainId(11155111);
        vm.expectRevert("LABx: mainnet only.");
        script.run();
        CreateMainnetSubscriptionHarness stage1 = new CreateMainnetSubscriptionHarness();
        vm.expectRevert("LABx: mainnet only.");
        stage1.create(0xB0B);
    }

    function test_refusesASafeWithoutCodeOrBelowTwoSignatures() public {
        vm.expectRevert(abi.encodeWithSelector(MainnetDeployment.SafeNotDeployed.selector, safe));
        script.validateSafe(safe);
        vm.etch(safe, hex"00");
        vm.mockCall(safe, abi.encodeWithSignature("getThreshold()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(MainnetDeployment.SafeThresholdTooLow.selector, safe, uint256(1)));
        script.validateSafe(safe);
        vm.mockCall(safe, abi.encodeWithSignature("getThreshold()"), abi.encode(uint256(2)));
        script.validateSafe(safe);
    }

    function test_refusesACallbackGasLimitTheContractWouldReject() public {
        vm.expectRevert(abi.encodeWithSelector(MainnetDeployment.CallbackGasOutOfRange.selector, uint256(199_999)));
        script.validateCallbackGas(199_999);
        vm.expectRevert(abi.encodeWithSelector(MainnetDeployment.CallbackGasOutOfRange.selector, uint256(2_500_001)));
        script.validateCallbackGas(2_500_001);
        script.validateCallbackGas(400_000);
    }
}

/// @notice Both deployment stages and one raffle lifecycle against real chain-1 state: Circle USDC, the Chainlink VRF v2.5
///         coordinator and the LABx Safe. Opt in with MAINNET_FORK_RPC_URL; skipped otherwise.
contract DeployMainnetForkTest is Test {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address internal constant SAFE = 0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1;
    bytes32 internal constant SUBSCRIPTION_CREATED = keccak256("SubscriptionCreated(uint256,address)");
    uint256 internal constant TEST_KEY = 0xB0B;
    uint256 internal constant CALLBACK_GAS = 400_000;
    uint256 internal constant FUND = 0.35 ether;

    DeployMainnetHarness internal stage2;
    address internal deployer = vm.addr(TEST_KEY);
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        vm.deal(deployer, 1 ether);
        stage2 = new DeployMainnetHarness();
    }

    /// @dev Runs stage 1 and returns the ID from the mined SubscriptionCreated log, as the operator reads it from the receipt.
    function _minedSubscription() internal returns (uint256 subId) {
        CreateMainnetSubscriptionHarness stage1 = new CreateMainnetSubscriptionHarness();
        vm.recordLogs();
        stage1.create(TEST_KEY);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == COORDINATOR && logs[i].topics[0] == SUBSCRIPTION_CREATED) return uint256(logs[i].topics[1]);
        }
        revert("no SubscriptionCreated log");
    }

    function _config(uint256 subId, address existing) internal pure returns (DeployMainnet.Config memory) {
        return DeployMainnet.Config({
            safe: SAFE,
            pk: TEST_KEY,
            terms: keccak256("labx mainnet rehearsal terms"),
            callbackGas: CALLBACK_GAS,
            fundWei: FUND,
            subId: subId,
            existing: existing
        });
    }

    function _accept(LabxRaffle labx, uint256 subId) internal {
        vm.startPrank(SAFE);
        labx.acceptOwnership();
        ICoordinatorView(COORDINATOR).acceptSubscriptionOwnerTransfer(subId);
        vm.stopPrank();
    }

    function test_deploysPausedOnTheMinedSubscriptionAndHandsEverythingToTheSafe() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = stage2.deploy(_config(subId, address(0)));
        assertEq(address(labx.usdc()), USDC);
        assertEq(labx.vrfCoordinator(), COORDINATOR);
        assertEq(labx.subscriptionId(), subId);
        assertEq(labx.callbackGasLimit(), CALLBACK_GAS);
        assertTrue(labx.nativePayment());
        assertTrue(labx.paused());
        assertFalse(labx.ethPathEnabled());
        assertEq(labx.treasury(), SAFE);
        assertEq(labx.owner(), deployer);
        assertEq(labx.pendingOwner(), SAFE);
        (, uint96 nativeBalance,, address subOwner, address[] memory consumers) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(nativeBalance, FUND);
        assertEq(subOwner, deployer);
        assertEq(consumers.length, 1);
        assertEq(consumers[0], address(labx));

        _accept(labx, subId);
        assertEq(labx.owner(), SAFE);
        assertEq(labx.pendingOwner(), address(0));
        (,,, subOwner,) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(subOwner, SAFE);
    }

    /// @dev The original single-script bug: a subscription ID from a simulation that was never mined. Stage 2 must refuse
    ///      it before deploying anything.
    function test_refusesAnUnminedSubscriptionIdBeforeDeploying() public {
        uint256 subId = _minedSubscription();
        uint64 nonce = vm.getNonce(deployer);
        vm.expectRevert();
        stage2.deploy(_config(subId + 1, address(0)));
        assertEq(vm.getNonce(deployer), nonce);
    }

    function test_refusesASubscriptionSomeoneElseOwns() public {
        address other = makeAddr("other");
        vm.prank(other);
        uint256 subId = ICoordinatorView(COORDINATOR).createSubscription();
        uint64 nonce = vm.getNonce(deployer);
        vm.expectRevert(abi.encodeWithSelector(MainnetDeployment.SubscriptionNotOwned.selector, subId, other));
        stage2.deploy(_config(subId, address(0)));
        assertEq(vm.getNonce(deployer), nonce);
    }

    /// @dev An interruption right after the raffle deployed: rerunning with RAFFLE_ADDRESS finishes every remaining step
    ///      and deploys nothing new.
    function test_resumesAfterAnInterruptedDeploymentWithoutDeployingAgain() public {
        uint256 subId = _minedSubscription();
        DeployMainnet.Config memory c = _config(subId, address(0));
        vm.prank(deployer);
        LabxRaffle labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: SAFE,
                usdc: USDC,
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 0,
                vrfCoordinator: COORDINATOR,
                keyHash: 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9,
                subscriptionId: subId,
                termsHash: c.terms,
                callbackGasLimit: uint32(CALLBACK_GAS),
                requestConfirmations: 3
            })
        );
        address next = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        c.existing = address(labx);
        c.fundWei = 0;
        assertEq(address(stage2.deploy(c)), address(labx));
        assertEq(next.code.length, 0);
        assertTrue(labx.paused());
        assertTrue(labx.nativePayment());
        assertEq(labx.pendingOwner(), SAFE);
        (,,,, address[] memory consumers) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(consumers.length, 1);
        assertEq(consumers[0], address(labx));
        // A second rerun changes nothing and still succeeds.
        stage2.deploy(c);
        (,,,, consumers) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(consumers.length, 1);
        _accept(labx, subId);
        assertEq(labx.owner(), SAFE);
    }

    /// @dev Measures counting under chain-1 gas rules today; Sepolia's October 2026 repricing made it about 230,000 gas a lot.
    function test_measuresCountingAndPurchaseGasForTwentyLots() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = stage2.deploy(_config(subId, address(0)));
        _accept(labx, subId);
        vm.prank(SAFE);
        labx.setPaused(false);
        MockERC721 nft = new MockERC721();
        nft.mint(seller, 1);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 1e6, bonusEntries: 1, maxSupply: 1000});
        vm.startPrank(seller);
        uint256 id = labx.createRaffle(address(nft), 1, uint64(block.timestamp + 1 days), bytes32(uint256(1)), keccak256("c"), "Gas", packs);
        nft.approve(address(labx), 1);
        labx.escrow(id);
        vm.stopPrank();
        bytes32 digest = labx.draftReviewHash(id);
        vm.prank(SAFE);
        labx.approveRaffle(id, digest);
        vm.prank(seller);
        labx.open(id);
        uint256 purchaseGas;
        for (uint256 i = 0; i < 20; i++) {
            address b = address(uint160(0x1000 + i));
            deal(USDC, b, 10e6);
            vm.startPrank(b);
            IUsdc(USDC).approve(address(labx), type(uint256).max);
            uint256 g = gasleft();
            labx.buyPack(id, 0, 1, labx.termsHash());
            purchaseGas = g - gasleft();
            vm.stopPrank();
        }
        emit log_named_uint("gas for the 20th purchase", purchaseGas);
        vm.warp(block.timestamp + 1 days);
        labx.close(id);
        uint256 before = gasleft();
        labx.snapshot(id, 20);
        emit log_named_uint("gas to count 20 lots", before - gasleft());
    }

    function test_runsOneRaffleThroughTheRealCoordinatorAndUsdc() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = stage2.deploy(_config(subId, address(0)));
        _accept(labx, subId);

        MockERC721 nft = new MockERC721();
        nft.mint(seller, 1);
        bytes32 nonce = bytes32(uint256(7));
        bytes32 publicHash = keccak256("public-summary");
        bytes32 privateHash = keccak256("private-commitment");
        bytes32 salt = bytes32(uint256(9));
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 25e6, bonusEntries: 1, maxSupply: 100});

        vm.startPrank(seller);
        uint256 id = labx.createRaffle(
            address(nft), 1, uint64(block.timestamp + 1 days), nonce,
            labx.hashCommitment(nonce, address(nft), 1, publicHash, privateHash, salt), "Mainnet rehearsal", packs
        );
        nft.approve(address(labx), 1);
        labx.escrow(id);
        vm.stopPrank();
        bytes32 digest = labx.draftReviewHash(id);
        vm.prank(SAFE);
        labx.approveRaffle(id, digest);
        // Deployed paused: nothing can open until the Safe unpauses at launch.
        vm.prank(seller);
        vm.expectRevert();
        labx.open(id);
        vm.prank(SAFE);
        labx.setPaused(false);
        vm.prank(seller);
        labx.open(id);

        deal(USDC, buyer, 100e6);
        vm.startPrank(buyer);
        IUsdc(USDC).approve(address(labx), type(uint256).max);
        labx.buyPack(id, 0, 1, labx.termsHash());
        vm.stopPrank();
        assertEq(IUsdc(USDC).balanceOf(buyer), 100e6 - 27_500_000);

        vm.warp(block.timestamp + 1 days);
        labx.close(id);
        labx.snapshot(id, 100);
        labx.requestRandomness(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;
        assertGt(requestId, 0);

        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        uint256 before = gasleft();
        vm.prank(COORDINATOR);
        labx.rawFulfillRandomWords(requestId, words);
        uint256 callbackGas = before - gasleft();
        emit log_named_uint("callback gas used", callbackGas);
        assertLt(callbackGas, CALLBACK_GAS / 2);
        assertEq(labx.getRaffle(id).winner, buyer);

        vm.prank(seller);
        labx.reveal(id, publicHash, privateHash, salt);
        labx.settle(id);
        vm.prank(buyer);
        labx.claimPrize(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        uint256 treasuryBefore = IUsdc(USDC).balanceOf(SAFE);
        labx.claimFee(id);
        assertEq(nft.ownerOf(1), buyer);
        assertEq(IUsdc(USDC).balanceOf(seller), 24_500_000);
        assertEq(IUsdc(USDC).balanceOf(SAFE) - treasuryBefore, 3_000_000);
    }
}
