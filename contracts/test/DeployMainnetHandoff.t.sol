// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";
import {CreateMainnetSubscriptionHarness, DeployMainnetHarness} from "./DeployMainnet.t.sol";

/// @notice The subscription half of the VRF v2.5 coordinator, with `s_subscriptionConfigs` at slot 5 as the script
///         reads it: {owner, requestedOwner, consumers}.
contract LayoutCoordinator {
    struct Config {
        address owner;
        address requestedOwner;
        address[] consumers;
    }

    uint256[5] private _slotsBefore;
    mapping(uint256 => Config) private _configs;
    mapping(uint256 => uint96) private _native;
    uint256 private _created;

    event SubscriptionCreated(uint256 indexed subId, address owner);

    function createSubscription() external returns (uint256 subId) {
        subId = 1000 + _created++;
        _configs[subId].owner = msg.sender;
        emit SubscriptionCreated(subId, msg.sender);
    }

    function getSubscription(uint256 subId)
        external
        view
        returns (uint96, uint96 nativeBalance, uint64, address subOwner, address[] memory consumers)
    {
        Config storage c = _configs[subId];
        require(c.owner != address(0), "InvalidSubscription");
        return (0, _native[subId], 0, c.owner, c.consumers);
    }

    function addConsumer(uint256 subId, address consumer) external {
        require(msg.sender == _configs[subId].owner, "owner");
        _configs[subId].consumers.push(consumer);
    }

    function fundSubscriptionWithNative(uint256 subId) external payable {
        _native[subId] += uint96(msg.value);
    }

    function requestSubscriptionOwnerTransfer(uint256 subId, address next) external {
        require(msg.sender == _configs[subId].owner, "owner");
        _configs[subId].requestedOwner = next;
    }

    function acceptSubscriptionOwnerTransfer(uint256 subId) external {
        require(msg.sender == _configs[subId].requestedOwner, "requested");
        _configs[subId].owner = msg.sender;
        _configs[subId].requestedOwner = address(0);
    }
}

/// @notice The stage 2 handoff without a fork: every interruption point of a fresh run, the four ownership pairs the
///         Safe can leave, and what verify accepts after launch. The coordinator and USDC are stand-ins placed at their
///         chain-1 addresses, so nothing here proves anything about the real coordinator; the fork suite does that.
contract DeployMainnetHandoffTest is Test {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 internal constant KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;
    bytes32 internal constant TERMS = keccak256("terms");
    uint256 internal constant KEY = 0xB0B;
    uint256 internal constant FUND = 0.35 ether;

    DeployMainnetHarness internal stage2;
    LayoutCoordinator internal coordinator = LayoutCoordinator(COORDINATOR);
    address internal deployer = vm.addr(KEY);
    address internal safe = makeAddr("safe");
    uint256 internal subId;

    function setUp() public {
        vm.chainId(1);
        vm.etch(COORDINATOR, address(new LayoutCoordinator()).code);
        vm.etch(USDC, hex"00");
        vm.mockCall(USDC, abi.encodeWithSignature("decimals()"), abi.encode(uint8(6)));
        vm.etch(safe, hex"00");
        vm.mockCall(safe, abi.encodeWithSignature("getThreshold()"), abi.encode(uint256(2)));
        vm.deal(deployer, 10 ether);
        stage2 = new DeployMainnetHarness();
        new CreateMainnetSubscriptionHarness().create(KEY, vm.getNonce(deployer));
        subId = 1000;
    }

    function _config(bool fresh, address existing) internal view returns (DeployMainnet.Config memory) {
        return DeployMainnet.Config({
            safe: safe,
            pk: KEY,
            terms: TERMS,
            fundTarget: FUND,
            subId: subId,
            fresh: fresh,
            expectedNonce: vm.getNonce(deployer),
            existing: existing
        });
    }

    function _verify(LabxRaffle labx) internal {
        stage2.verifyDeployment(_config(false, address(labx)), deployer);
    }

    /// @dev What stage 2 does, stopped after `steps` of its six transactions.
    function _partial(uint256 steps) internal returns (LabxRaffle labx) {
        vm.startPrank(deployer);
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: safe,
                usdc: USDC,
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 0,
                vrfCoordinator: COORDINATOR,
                keyHash: KEY_HASH,
                subscriptionId: subId,
                termsHash: TERMS,
                callbackGasLimit: 400_000,
                requestConfirmations: 3
            })
        );
        if (steps > 1) labx.setNativePayment(true);
        if (steps > 2) coordinator.addConsumer(subId, address(labx));
        if (steps > 3) coordinator.fundSubscriptionWithNative{value: FUND}(subId);
        if (steps > 4) labx.transferOwnership(safe);
        if (steps > 5) coordinator.requestSubscriptionOwnerTransfer(subId, safe);
        vm.stopPrank();
    }

    function _assertHandedOff(LabxRaffle labx) internal view {
        (, uint96 native,, address subOwner, address[] memory consumers) = coordinator.getSubscription(subId);
        assertEq(labx.owner(), deployer);
        assertEq(labx.pendingOwner(), safe);
        assertTrue(labx.paused());
        assertTrue(labx.nativePayment());
        assertEq(subOwner, deployer);
        assertEq(stage2.subscription(subId).requestedOwner, safe);
        assertEq(consumers.length, 1);
        assertEq(consumers[0], address(labx));
        assertEq(native, FUND);
    }

    function test_freshRunHandsOffAndASecondFreshRunIsRefused() public {
        DeployMainnet.Config memory c = _config(true, address(0));
        LabxRaffle labx = stage2.deploy(c);
        assertEq(address(labx), vm.computeCreateAddress(deployer, c.expectedNonce));
        _assertHandedOff(labx);
        _verify(labx);

        vm.expectRevert(
            abi.encodeWithSelector(DeployMainnet.NonceMoved.selector, c.expectedNonce, vm.getNonce(deployer))
        );
        stage2.deploy(c);
        // With the nonce updated a fresh run is still refused: the subscription is no longer untouched.
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.SubscriptionInUse.selector, subId));
        stage2.deploy(_config(true, address(0)));
    }

    /// @dev A fresh run stopped after each of its transactions: verify refuses the partial state, one resume reaches
    ///      the same handoff as an uninterrupted run with exactly the funding target, and a second resume sends nothing.
    function test_resumeFromEveryInterruptionReachesTheSameHandoff() public {
        for (uint256 steps = 1; steps <= 6; ++steps) {
            uint256 start = vm.snapshotState();
            LabxRaffle labx = _partial(steps);
            if (steps < 6) {
                vm.expectRevert();
                this.verifyExternally(labx);
            }
            assertEq(address(stage2.deploy(_config(false, address(labx)))), address(labx));
            _assertHandedOff(labx);
            _verify(labx);

            uint256 nonce = vm.getNonce(deployer);
            uint256 balance = deployer.balance;
            stage2.deploy(_config(false, address(labx)));
            assertEq(vm.getNonce(deployer), nonce, "a second resume sends nothing");
            assertEq(deployer.balance, balance, "a second resume funds nothing");
            vm.revertToState(start);
        }
    }

    function verifyExternally(LabxRaffle labx) external {
        _verify(labx);
    }

    /// @dev The Safe may accept the raffle, the subscription, both or neither; verify passes all four.
    function test_verifyPassesEveryOwnershipPairTheSafeCanLeave() public {
        LabxRaffle labx = stage2.deploy(_config(true, address(0)));
        for (uint256 pair; pair < 4; ++pair) {
            uint256 start = vm.snapshotState();
            vm.startPrank(safe);
            if (pair & 1 != 0) labx.acceptOwnership();
            if (pair & 2 != 0) coordinator.acceptSubscriptionOwnerTransfer(subId);
            vm.stopPrank();
            _verify(labx);
            vm.revertToState(start);
        }
    }

    /// @dev Once the Safe owns the raffle, a missing step is the Safe's to take: resume names the call and sends none.
    function test_resumeNamesTheSafeActionWhenTheSafeAlreadyOwnsTheRaffle() public {
        LabxRaffle labx = _partial(1);
        vm.prank(deployer);
        labx.transferOwnership(safe);
        vm.prank(safe);
        labx.acceptOwnership();
        vm.expectRevert(
            abi.encodeWithSelector(DeployMainnet.SafeActionRequired.selector, "raffle.setNativePayment(true)")
        );
        stage2.deploy(_config(false, address(labx)));
    }

    /// @dev E4: after launch the pause flag and the terms hash are the Safe's, and verify passes. "Launched" is not
    ///      stored anywhere: it is read as "the Safe owns the raffle and it is not paused". So a launched raffle that
    ///      the Safe pauses again reads as not launched, and verify then requires the original terms hash.
    function test_verifyReadsARepausedRaffleAsNotLaunched() public {
        LabxRaffle labx = stage2.deploy(_config(true, address(0)));
        vm.startPrank(safe);
        labx.acceptOwnership();
        coordinator.acceptSubscriptionOwnerTransfer(subId);
        labx.setPaused(false);
        labx.setTermsHash(keccak256("terms v2"));
        vm.stopPrank();
        _verify(labx);

        vm.prank(safe);
        labx.setPaused(true);
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.RaffleSettingMismatch.selector, "termsHash"));
        _verify(labx);

        // Pausing alone, with the deployment's terms, still verifies.
        vm.prank(safe);
        labx.setTermsHash(TERMS);
        _verify(labx);
    }
}
