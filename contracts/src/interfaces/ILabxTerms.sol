// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ILabxTerms
/// @notice Versioned "I agree" registry. The UI renders one checkbox per required document and the
///         accepted version number is recorded on-chain so a dispute can be tied to exact wording.
interface ILabxTerms {
    struct Document {
        uint32 version;
        uint64 publishedAt;
        bytes32 contentHash; // keccak256 of the published document body
        string uri; // ipfs:// or https://labx.art/legal/...
    }

    function currentVersion(bytes32 key) external view returns (uint32);

    function acceptedVersion(address user, bytes32 key) external view returns (uint32);

    function hasAcceptedAll(address user) external view returns (bool);

    function requireAccepted(address user) external view;
}
