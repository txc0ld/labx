// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IVRFCoordinatorV2Plus} from "../vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../vendor/chainlink/VRFV2PlusClient.sol";

/// @title LabxVRFConsumerBase
/// @notice Chainlink VRF v2.5 consumer plumbing: holds the coordinator/subscription config and
///         exposes the `rawFulfillRandomWords` entrypoint the coordinator calls back into.
/// @dev Mirrors Chainlink's `VRFConsumerBaseV2Plus` but leaves ownership/authorisation to the
///      inheriting contract so LABx can keep a single `AccessControl` surface.
abstract contract LabxVRFConsumerBase {
    struct VrfConfig {
        bytes32 keyHash;
        uint256 subscriptionId;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        bool nativePayment;
    }

    IVRFCoordinatorV2Plus public vrfCoordinator;
    VrfConfig public vrfConfig;

    event VrfCoordinatorUpdated(address indexed previous, address indexed current);
    event VrfConfigUpdated(
        bytes32 keyHash,
        uint256 subscriptionId,
        uint32 callbackGasLimit,
        uint16 requestConfirmations,
        bool nativePayment
    );

    error OnlyCoordinatorCanFulfill(address caller, address coordinator);
    error ZeroCoordinator();
    error InvalidVrfConfig();

    constructor(address coordinator, VrfConfig memory config) {
        _setVrfCoordinator(coordinator);
        _setVrfConfig(config);
    }

    /// @notice Coordinator callback. Validates the caller then hands off to the implementation.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(vrfCoordinator)) {
            revert OnlyCoordinatorCanFulfill(msg.sender, address(vrfCoordinator));
        }
        _fulfillRandomWords(requestId, randomWords);
    }

    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;

    function _requestRandomWords(uint32 numWords) internal returns (uint256 requestId) {
        VrfConfig memory config = vrfConfig;
        return vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: config.keyHash,
                subId: config.subscriptionId,
                requestConfirmations: config.requestConfirmations,
                callbackGasLimit: config.callbackGasLimit,
                numWords: numWords,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: config.nativePayment})
                )
            })
        );
    }

    function _setVrfCoordinator(address coordinator) internal {
        if (coordinator == address(0)) revert ZeroCoordinator();
        emit VrfCoordinatorUpdated(address(vrfCoordinator), coordinator);
        vrfCoordinator = IVRFCoordinatorV2Plus(coordinator);
    }

    function _setVrfConfig(VrfConfig memory config) internal {
        if (config.keyHash == bytes32(0) || config.callbackGasLimit == 0 || config.requestConfirmations == 0) {
            revert InvalidVrfConfig();
        }
        vrfConfig = config;
        emit VrfConfigUpdated(
            config.keyHash,
            config.subscriptionId,
            config.callbackGasLimit,
            config.requestConfirmations,
            config.nativePayment
        );
    }
}
