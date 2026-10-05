// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {VRFV2PlusClient} from "./VRFV2PlusClient.sol";

/// @notice The subset of Chainlink's VRF v2.5 coordinator surface that LABx consumes.
/// @dev Vendored instead of pulling the full `chainlink` package so the Foundry build stays dependency-light.
///      Source: https://github.com/smartcontractkit/chainlink (contracts/src/v0.8/vrf/dev/interfaces)
interface IVRFCoordinatorV2Plus {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId);

    function getSubscription(uint256 subId)
        external
        view
        returns (
            uint96 balance,
            uint96 nativeBalance,
            uint64 reqCount,
            address subOwner,
            address[] memory consumers
        );
}
