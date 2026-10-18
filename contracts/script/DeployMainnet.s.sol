// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";

interface IVRFSubscriptionAdmin {
    function createSubscription() external returns (uint256 subId);
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] memory consumers);
    function addConsumer(uint256 subId, address consumer) external;
    function fundSubscriptionWithNative(uint256 subId) external payable;
    function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner) external;
}

interface ISafeOwners {
    function getThreshold() external view returns (uint256);
}

/// @notice Chain-1 addresses and checks shared by both deployment stages.
abstract contract MainnetDeployment is Script {
    error SafeNotDeployed(address safe);
    error SafeThresholdTooLow(address safe, uint256 threshold);
    error CallbackGasOutOfRange(uint256 callbackGasLimit);
    error SubscriptionNotOwned(uint256 subId, address owner);
    error RaffleMismatch(address raffle);

    // Read on chain 1 on 19 October 2026: Circle USDC (6 decimals), the Chainlink VRF v2.5 coordinator and its 200 gwei
    // key hash (s_provingKeys returned exists with maxGas 200 gwei).
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 internal constant VRF_KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;

    function _requireMainnet() internal view {
        if (block.chainid != 1) revert("LABx: mainnet only.");
    }

    /// @dev The contract's own bounds, checked before anything is broadcast.
    function _validateCallbackGas(uint256 callbackGas) internal pure {
        if (callbackGas < 200_000 || callbackGas > 2_500_000) revert CallbackGasOutOfRange(callbackGas);
    }

    /// @dev Refuses an EOA, an undeployed Safe, or a Safe that one key can control.
    function _validateSafe(address safe) internal view {
        if (safe.code.length == 0) revert SafeNotDeployed(safe);
        uint256 threshold = ISafeOwners(safe).getThreshold();
        if (threshold < 2) revert SafeThresholdTooLow(safe, threshold);
    }
}

/// @notice Stage 1: creates the VRF subscription, owned by the deployer. The coordinator derives the ID from the mined
///         block and its subscription nonce, so a simulated ID can differ from the real one. Read the ID from the
///         SubscriptionCreated event in the mined receipt and pass that to DeployMainnet; never reuse this script's output.
contract CreateMainnetSubscription is MainnetDeployment {
    function run() external {
        _requireMainnet();
        _create(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        console2.log("Read the subscription ID from SubscriptionCreated in the mined receipt, not from this simulation.");
    }

    function _create(uint256 pk) internal {
        _requireMainnet();
        vm.startBroadcast(pk);
        IVRFSubscriptionAdmin(VRF_COORDINATOR).createSubscription();
        vm.stopBroadcast();
    }
}

/// @notice Stage 2: deploys the raffle pinned to the mined subscription and hands both to the Safe. The raffle starts
///         paused, so nothing can be admitted, opened or bought while the deployer still owns it; the Safe unpauses at
///         launch. Every step checks chain state first, so rerunning with RAFFLE_ADDRESS after an interruption finishes the
///         remaining steps without deploying again. Every other chain id is refused.
contract DeployMainnet is MainnetDeployment {
    struct Config {
        address safe;
        uint256 pk;
        bytes32 terms;
        // A reviewed value: it sets the subscription reserve Chainlink expects before answering a draw.
        uint256 callbackGas;
        uint256 fundWei;
        // The ID from the mined SubscriptionCreated event of stage 1.
        uint256 subId;
        // Zero for a first run; the deployed raffle when resuming.
        address existing;
    }

    function run() external returns (LabxRaffle labx) {
        _requireMainnet();
        return _deploy(
            Config({
                safe: vm.envAddress("SAFE_ADDRESS"),
                pk: vm.envUint("DEPLOYER_PRIVATE_KEY"),
                terms: vm.envBytes32("TERMS_HASH"),
                callbackGas: vm.envUint("VRF_CALLBACK_GAS_LIMIT"),
                fundWei: vm.envOr("VRF_FUND_WEI", uint256(0)),
                subId: vm.envUint("VRF_SUBSCRIPTION_ID"),
                existing: vm.envOr("RAFFLE_ADDRESS", address(0))
            })
        );
    }

    function _deploy(Config memory c) internal returns (LabxRaffle labx) {
        _requireMainnet();
        _validateSafe(c.safe);
        _validateCallbackGas(c.callbackGas);
        address deployer = vm.addr(c.pk);
        IVRFSubscriptionAdmin coordinator = IVRFSubscriptionAdmin(VRF_COORDINATOR);
        // Reverts InvalidSubscription for an ID that was never mined, such as one taken from a simulation.
        (,,, address subOwner, address[] memory consumers) = coordinator.getSubscription(c.subId);
        if (subOwner != deployer && subOwner != c.safe) revert SubscriptionNotOwned(c.subId, subOwner);

        vm.startBroadcast(c.pk);
        if (c.existing == address(0)) {
            labx = new LabxRaffle(
                LabxRaffle.Init({
                    treasury: c.safe,
                    usdc: USDC,
                    router: address(0),
                    weth: address(0),
                    ethUsdFeed: address(0),
                    poolFee: 0,
                    vrfCoordinator: VRF_COORDINATOR,
                    keyHash: VRF_KEY_HASH,
                    subscriptionId: c.subId,
                    termsHash: c.terms,
                    callbackGasLimit: uint32(c.callbackGas),
                    requestConfirmations: 3
                })
            );
        } else {
            labx = LabxRaffle(payable(c.existing));
            if (labx.subscriptionId() != c.subId || labx.vrfCoordinator() != VRF_COORDINATOR || labx.treasury() != c.safe) {
                revert RaffleMismatch(c.existing);
            }
        }
        if (labx.owner() == deployer) {
            if (!labx.nativePayment()) labx.setNativePayment(true);
            if (!labx.paused()) labx.setPaused(true);
        }
        if (subOwner == deployer && !_contains(consumers, address(labx))) coordinator.addConsumer(c.subId, address(labx));
        if (c.fundWei > 0) coordinator.fundSubscriptionWithNative{value: c.fundWei}(c.subId);
        if (labx.owner() == deployer && labx.pendingOwner() != c.safe) labx.transferOwnership(c.safe);
        // Idempotent on the coordinator: an unchanged requested owner is a no-op.
        if (subOwner == deployer) coordinator.requestSubscriptionOwnerTransfer(c.subId, c.safe);
        vm.stopBroadcast();

        console2.log("LabxRaffle", address(labx));
        console2.log("VRF subscription", c.subId);
        console2.log("Safe must accept both transfers, then unpause the raffle at launch");
    }

    function _contains(address[] memory items, address item) private pure returns (bool) {
        for (uint256 i = 0; i < items.length; i++) {
            if (items[i] == item) return true;
        }
        return false;
    }
}
