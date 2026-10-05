// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title LabxRoles
/// @notice Shared role definitions for every LABx contract.
/// @dev `DEFAULT_ADMIN_ROLE` is granted to the Fantom Labs Safe multisig at deploy time. Every other
///      role is granted from that Safe, so no single hot key can move funds or prizes.
abstract contract LabxRoles is AccessControl {
    /// @notice Day-to-day automation: closing raffles, requesting VRF, delivering prizes (platform pays gas).
    bytes32 public constant OPERATIONS_ROLE = keccak256("LABX_OPERATIONS_ROLE");
    /// @notice Curates raffles and discount-marketplace offers.
    bytes32 public constant CURATOR_ROLE = keccak256("LABX_CURATOR_ROLE");
    /// @notice Signs off-chain attestations (captcha + wallet-signature results, jurisdiction, points).
    bytes32 public constant ATTESTOR_ROLE = keccak256("LABX_ATTESTOR_ROLE");
    /// @notice May spend/refund a member's entry balance. Granted to the raffle house only.
    bytes32 public constant ENTRY_SPENDER_ROLE = keccak256("LABX_ENTRY_SPENDER_ROLE");
    /// @notice May mint zero-value (free / AMOE / points) entries.
    bytes32 public constant ENTRY_ISSUER_ROLE = keccak256("LABX_ENTRY_ISSUER_ROLE");
    /// @notice May buy a tier on a member's behalf (one-click "Get entries" router).
    bytes32 public constant PURCHASE_ROUTER_ROLE = keccak256("LABX_PURCHASE_ROUTER_ROLE");

    error ZeroAddress();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }
}
