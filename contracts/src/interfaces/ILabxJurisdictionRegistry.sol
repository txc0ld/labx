// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ILabxJurisdictionRegistry
/// @notice Optional geo gating. Gates are DISABLED by default: `isAllowed` returns true for everyone
///         until an admin explicitly enables them, so turning gating on is a deliberate legal decision.
interface ILabxJurisdictionRegistry {
    function gatesEnabled() external view returns (bool);

    function isAllowed(address user) external view returns (bool);

    function requireAllowed(address user) external view;
}
