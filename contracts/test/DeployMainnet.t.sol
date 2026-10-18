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
    function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner) external;
    function addConsumer(uint256 subId, address consumer) external;
    function fundSubscriptionWithNative(uint256 subId) external payable;
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

    function subscription(uint256 subId) external view returns (Subscription memory) {
        return _subscription(subId);
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
}

/// @notice Both deployment stages and one raffle lifecycle against real chain-1 state: Circle USDC, the Chainlink VRF v2.5
///         coordinator and the LABx Safe. Opt in with MAINNET_FORK_RPC_URL; skipped otherwise.
contract DeployMainnetForkTest is Test {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address internal constant SAFE = 0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1;
    bytes32 internal constant KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;
    bytes32 internal constant TERMS = keccak256("labx mainnet rehearsal terms");
    bytes32 internal constant SUBSCRIPTION_CREATED = keccak256("SubscriptionCreated(uint256,address)");
    uint256 internal constant TEST_KEY = 0xB0B;
    uint32 internal constant CALLBACK_GAS = 400_000;
    uint256 internal constant FUND = 0.35 ether;

    DeployMainnetHarness internal stage2;
    ICoordinatorView internal coordinator = ICoordinatorView(COORDINATOR);
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
            if (logs[i].emitter == COORDINATOR && logs[i].topics[0] == SUBSCRIPTION_CREATED) {
                return uint256(logs[i].topics[1]);
            }
        }
        revert("no SubscriptionCreated log");
    }

    function _config(uint256 subId, address existing) internal pure returns (DeployMainnet.Config memory) {
        return DeployMainnet.Config({
            safe: SAFE, pk: TEST_KEY, terms: TERMS, fundTarget: FUND, subId: subId, existing: existing
        });
    }

    function _raffleFrom(address from, uint256 subId, uint24 poolFee, uint32 callbackGas)
        internal
        returns (LabxRaffle)
    {
        vm.prank(from);
        return new LabxRaffle(
            LabxRaffle.Init({
                treasury: SAFE,
                usdc: USDC,
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: poolFee,
                vrfCoordinator: COORDINATOR,
                keyHash: KEY_HASH,
                subscriptionId: subId,
                termsHash: TERMS,
                callbackGasLimit: callbackGas,
                requestConfirmations: 3
            })
        );
    }

    /// @dev The state when stage 2 stopped right after its deployment mined.
    function _interrupted(uint256 subId) internal returns (LabxRaffle) {
        return _raffleFrom(deployer, subId, 0, CALLBACK_GAS);
    }

    function _nativeBalance(uint256 subId) internal view returns (uint96 nativeBalance) {
        (, nativeBalance,,,) = coordinator.getSubscription(subId);
    }

    function _consumers(uint256 subId) internal view returns (address[] memory consumers) {
        (,,,, consumers) = coordinator.getSubscription(subId);
    }

    function _accept(LabxRaffle labx, uint256 subId) internal {
        vm.startPrank(SAFE);
        labx.acceptOwnership();
        coordinator.acceptSubscriptionOwnerTransfer(subId);
        vm.stopPrank();
    }

    /// @dev Expects stage 2 to refuse with `reason` and to have spent nothing.
    function _refused(DeployMainnet.Config memory c, bytes memory reason) internal {
        uint64 nonce = vm.getNonce(deployer);
        uint256 balance = deployer.balance;
        vm.expectRevert(reason);
        stage2.deploy(c);
        assertEq(vm.getNonce(deployer), nonce);
        assertEq(deployer.balance, balance);
    }

    function _settingMismatch(string memory setting) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DeployMainnet.RaffleSettingMismatch.selector, setting);
    }

    function _safeAction(string memory action) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(DeployMainnet.SafeActionRequired.selector, action);
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
        MainnetDeployment.Subscription memory sub = stage2.subscription(subId);
        assertEq(sub.nativeBalance, FUND);
        assertEq(sub.owner, deployer);
        assertEq(sub.requestedOwner, SAFE);
        assertEq(sub.consumers.length, 1);
        assertEq(sub.consumers[0], address(labx));

        _accept(labx, subId);
        assertEq(labx.owner(), SAFE);
        assertEq(labx.pendingOwner(), address(0));
        sub = stage2.subscription(subId);
        assertEq(sub.owner, SAFE);
        assertEq(sub.requestedOwner, address(0));
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
        uint256 subId = coordinator.createSubscription();
        _refused(
            _config(subId, address(0)),
            abi.encodeWithSelector(MainnetDeployment.SubscriptionNotOwned.selector, subId, other)
        );
    }

    /// @dev A fresh run only takes the untouched stage 1 subscription, so a rerun that lost RAFFLE_ADDRESS cannot deploy
    ///      and register a second raffle.
    function test_freshRunRefusesASubscriptionAlreadyInUse() public {
        uint256 subId = _minedSubscription();
        stage2.deploy(_config(subId, address(0)));
        _refused(_config(subId, address(0)), abi.encodeWithSelector(DeployMainnet.SubscriptionInUse.selector, subId));
        assertEq(_consumers(subId).length, 1);

        uint256 offered = _minedSubscription();
        vm.prank(deployer);
        coordinator.requestSubscriptionOwnerTransfer(offered, SAFE);
        _refused(
            _config(offered, address(0)), abi.encodeWithSelector(DeployMainnet.SubscriptionInUse.selector, offered)
        );
        vm.prank(SAFE);
        coordinator.acceptSubscriptionOwnerTransfer(offered);
        _refused(
            _config(offered, address(0)), abi.encodeWithSelector(DeployMainnet.SubscriptionInUse.selector, offered)
        );
    }

    /// @dev An interruption right after the raffle deployed: rerunning with RAFFLE_ADDRESS finishes every remaining step
    ///      and deploys nothing new. Reruns before and after the Safe accepts send nothing more.
    function test_resumesAfterAnInterruptedDeploymentWithoutDeployingAgain() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        address next = vm.computeCreateAddress(deployer, vm.getNonce(deployer));
        assertEq(address(stage2.deploy(_config(subId, address(labx)))), address(labx));
        assertEq(next.code.length, 0);
        assertTrue(labx.paused());
        assertTrue(labx.nativePayment());
        assertEq(labx.pendingOwner(), SAFE);
        assertEq(_nativeBalance(subId), FUND);
        assertEq(_consumers(subId).length, 1);
        assertEq(_consumers(subId)[0], address(labx));

        uint64 nonce = vm.getNonce(deployer);
        stage2.deploy(_config(subId, address(labx)));
        assertEq(vm.getNonce(deployer), nonce);
        _accept(labx, subId);
        stage2.deploy(_config(subId, address(labx)));
        assertEq(vm.getNonce(deployer), nonce);
        assertEq(_nativeBalance(subId), FUND);
        assertEq(labx.owner(), SAFE);
    }

    /// @dev Funding is a target, not an amount: a rerun adds nothing, and a resume after partial funding sends the shortfall.
    function test_fundsOnlyUpToTheTarget() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = stage2.deploy(_config(subId, address(0)));
        assertEq(_nativeBalance(subId), FUND);
        stage2.deploy(_config(subId, address(labx)));
        assertEq(_nativeBalance(subId), FUND);

        uint256 partlyFunded = _minedSubscription();
        LabxRaffle interrupted = _interrupted(partlyFunded);
        vm.prank(deployer);
        coordinator.fundSubscriptionWithNative{value: 0.1 ether}(partlyFunded);
        uint256 before = deployer.balance;
        stage2.deploy(_config(partlyFunded, address(interrupted)));
        assertEq(_nativeBalance(partlyFunded), FUND);
        assertEq(before - deployer.balance, FUND - 0.1 ether);
    }

    /// @dev Pause blocks opening from the moment of deployment, but not administration, and the Safe's acceptance voids
    ///      anything the deployer approved before it.
    function test_startsPausedAndSafeAcceptanceVoidsDeployerApprovals() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        assertTrue(labx.paused());
        MockERC721 nft = new MockERC721();
        nft.mint(seller, 1);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 25e6, bonusEntries: 1, maxSupply: 100});
        vm.startPrank(seller);
        uint256 id = labx.createRaffle(
            address(nft), 1, uint64(block.timestamp + 1 days), bytes32(uint256(1)), keccak256("c"), "Early", packs
        );
        nft.approve(address(labx), 1);
        labx.escrow(id);
        vm.stopPrank();
        bytes32 digest = labx.draftReviewHash(id);
        vm.prank(deployer);
        labx.approveRaffle(id, digest);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.Paused.selector);
        labx.open(id);

        stage2.deploy(_config(subId, address(labx)));
        _accept(labx, subId);
        vm.prank(SAFE);
        labx.setPaused(false);
        vm.prank(seller);
        vm.expectRevert(LabxRaffle.AdmissionRequired.selector);
        labx.open(id);
    }

    function test_resumeRefusesARaffleSomeoneElseOwnsOrIsOffered() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        address foreign = makeAddr("foreign");
        vm.prank(deployer);
        labx.transferOwnership(foreign);
        _refused(
            _config(subId, address(labx)),
            abi.encodeWithSelector(DeployMainnet.RaffleOwnershipUnexpected.selector, deployer, foreign)
        );
        vm.prank(foreign);
        labx.acceptOwnership();
        _refused(
            _config(subId, address(labx)),
            abi.encodeWithSelector(DeployMainnet.RaffleOwnershipUnexpected.selector, foreign, address(0))
        );
        LabxRaffle theirs = _raffleFrom(foreign, subId, 0, CALLBACK_GAS);
        _refused(
            _config(subId, address(theirs)),
            abi.encodeWithSelector(DeployMainnet.RaffleOwnershipUnexpected.selector, foreign, address(0))
        );
        assertEq(_consumers(subId).length, 0);
    }

    function test_resumeRefusesChangedSettings() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        DeployMainnet.Config memory c = _config(subId, address(labx));
        uint256 untouched = vm.snapshotState();

        vm.prank(deployer);
        labx.setTermsHash(keccak256("other terms"));
        _refused(c, _settingMismatch("termsHash"));
        vm.revertToState(untouched);
        vm.prank(deployer);
        labx.setVrfConfig(bytes32(uint256(999)), subId, CALLBACK_GAS, 3);
        _refused(c, _settingMismatch("keyHash"));
        vm.revertToState(untouched);
        vm.prank(deployer);
        labx.setVrfConfig(KEY_HASH, subId, 200_000, 3);
        _refused(c, _settingMismatch("callbackGasLimit"));
        vm.revertToState(untouched);
        vm.prank(deployer);
        labx.setPaused(false);
        _refused(c, _settingMismatch("paused"));
        vm.revertToState(untouched);
        vm.prank(deployer);
        labx.proposeCoordinator(USDC);
        _refused(c, _settingMismatch("pendingCoordinator"));
    }

    /// @dev Callback gas is no longer an input. A raffle deployed with a different immutable has different code; one
    ///      deployed with different callback gas has the same code and fails the settings check.
    function test_resumeRefusesARaffleDeployedWithDifferentInit() public {
        uint256 subId = _minedSubscription();
        LabxRaffle otherPoolFee = _raffleFrom(deployer, subId, 500, CALLBACK_GAS);
        _refused(
            _config(subId, address(otherPoolFee)),
            abi.encodeWithSelector(DeployMainnet.RaffleCodeMismatch.selector, address(otherPoolFee))
        );
        LabxRaffle lowGas = _raffleFrom(deployer, subId, 0, 250_000);
        _refused(_config(subId, address(lowGas)), _settingMismatch("callbackGasLimit"));
        _refused(_config(subId, USDC), abi.encodeWithSelector(DeployMainnet.RaffleCodeMismatch.selector, USDC));
        address empty = makeAddr("empty");
        _refused(_config(subId, empty), abi.encodeWithSelector(DeployMainnet.RaffleCodeMismatch.selector, empty));
    }

    function test_resumeRefusesASubscriptionWithAnotherConsumer() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        vm.prank(deployer);
        coordinator.addConsumer(subId, makeAddr("other consumer"));
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.SubscriptionConsumersUnexpected.selector, subId));
        stage2.deploy(_config(subId, address(labx)));
        assertEq(_consumers(subId).length, 1);
    }

    /// @dev Once the Safe owns the subscription only the Safe can add the consumer, so the resume names that action
    ///      instead of reporting success, and finishes after it.
    function test_safeOwnedSubscriptionNamesTheMissingConsumer() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        vm.prank(deployer);
        coordinator.requestSubscriptionOwnerTransfer(subId, SAFE);
        vm.prank(SAFE);
        coordinator.acceptSubscriptionOwnerTransfer(subId);
        _refused(_config(subId, address(0)), abi.encodeWithSelector(DeployMainnet.SubscriptionInUse.selector, subId));
        // Refused after simulating its own steps: a forge script run then sends nothing. A test cannot roll back the
        // broadcast nonce, so check the state instead.
        vm.expectRevert(_safeAction("coordinator.addConsumer(subId, raffle)"));
        stage2.deploy(_config(subId, address(labx)));
        assertEq(_consumers(subId).length, 0);
        assertEq(_nativeBalance(subId), 0);
        assertEq(labx.pendingOwner(), address(0));

        vm.prank(SAFE);
        coordinator.addConsumer(subId, address(labx));
        stage2.deploy(_config(subId, address(labx)));
        assertTrue(labx.nativePayment());
        assertEq(labx.pendingOwner(), SAFE);
        assertEq(_nativeBalance(subId), FUND);
    }

    /// @dev Once the Safe owns the raffle only the Safe can turn on native billing.
    function test_safeOwnedRaffleNamesNativeBilling() public {
        uint256 subId = _minedSubscription();
        LabxRaffle labx = _interrupted(subId);
        vm.prank(deployer);
        labx.transferOwnership(SAFE);
        vm.prank(SAFE);
        labx.acceptOwnership();
        vm.expectRevert(_safeAction("raffle.setNativePayment(true)"));
        stage2.deploy(_config(subId, address(labx)));
        assertEq(_consumers(subId).length, 0);
        assertEq(_nativeBalance(subId), 0);

        vm.prank(SAFE);
        labx.setNativePayment(true);
        stage2.deploy(_config(subId, address(labx)));
        assertEq(_consumers(subId)[0], address(labx));
        assertEq(stage2.subscription(subId).requestedOwner, SAFE);
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
        uint256 id = labx.createRaffle(
            address(nft), 1, uint64(block.timestamp + 1 days), bytes32(uint256(1)), keccak256("c"), "Gas", packs
        );
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
            address(nft),
            1,
            uint64(block.timestamp + 1 days),
            nonce,
            labx.hashCommitment(nonce, address(nft), 1, publicHash, privateHash, salt),
            "Mainnet rehearsal",
            packs
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
