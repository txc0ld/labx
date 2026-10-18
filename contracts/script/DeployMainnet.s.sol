// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";

interface IVRFSubscriptionAdmin {
    function createSubscription() external returns (uint256 subId);
    function addConsumer(uint256 subId, address consumer) external;
    function fundSubscriptionWithNative(uint256 subId) external payable;
    function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner) external;
}

interface ISafeOwners {
    function getThreshold() external view returns (uint256);
}

/// @notice Deploys LABx to Ethereum mainnet in one broadcast: a new VRF subscription, the raffle pinned to it, the raffle
///         as its consumer, optional native funding, and ownership transfers of both the raffle and the subscription to
///         the Safe. The Safe then accepts both in one transaction. Every other chain id is refused.
contract DeployMainnet is Script {
    error SafeNotDeployed(address safe);
    error SafeThresholdTooLow(address safe, uint256 threshold);
    error CallbackGasOutOfRange(uint256 callbackGasLimit);

    // Read on chain 1 on 19 October 2026: Circle USDC (6 decimals), the Chainlink VRF v2.5 coordinator and its 200 gwei
    // key hash (s_provingKeys returned exists with maxGas 200 gwei).
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 internal constant VRF_KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;

    function run() external returns (LabxRaffle labx, uint256 subId) {
        if (block.chainid != 1) revert("LABx: mainnet only.");
        address safe = vm.envAddress("SAFE_ADDRESS");
        _validateSafe(safe);
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        bytes32 terms = vm.envBytes32("TERMS_HASH");
        // A reviewed value, not a default: it sets the subscription balance Chainlink requires before answering a draw.
        uint256 callbackGas = vm.envUint("VRF_CALLBACK_GAS_LIMIT");
        _validateCallbackGas(callbackGas);
        uint256 fundWei = vm.envOr("VRF_FUND_WEI", uint256(0));

        IVRFSubscriptionAdmin coordinator = IVRFSubscriptionAdmin(VRF_COORDINATOR);
        vm.startBroadcast(pk);
        subId = coordinator.createSubscription();
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: safe,
                usdc: USDC,
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 0,
                vrfCoordinator: VRF_COORDINATOR,
                keyHash: VRF_KEY_HASH,
                subscriptionId: subId,
                termsHash: terms,
                callbackGasLimit: uint32(callbackGas),
                requestConfirmations: 3
            })
        );
        labx.setNativePayment(true);
        coordinator.addConsumer(subId, address(labx));
        if (fundWei > 0) coordinator.fundSubscriptionWithNative{value: fundWei}(subId);
        labx.transferOwnership(safe);
        coordinator.requestSubscriptionOwnerTransfer(subId, safe);
        vm.stopBroadcast();

        console2.log("LabxRaffle", address(labx));
        console2.log("VRF subscription", subId);
        console2.log("Safe must call acceptOwnership on LabxRaffle and acceptSubscriptionOwnerTransfer on the coordinator");
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
