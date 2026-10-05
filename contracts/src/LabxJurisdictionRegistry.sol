// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxJurisdictionRegistry} from "./interfaces/ILabxJurisdictionRegistry.sol";

/// @title LabxJurisdictionRegistry
/// @notice Geo gating for LABx, shipped switched OFF.
/// @dev While `gatesEnabled == false` every address passes, so the platform behaves as if the registry
///      were absent. Flipping it on is a conscious compliance step (see `docs/legal-notes.md`): only then
///      do country attestations, allow-lists and deny-lists take effect.
contract LabxJurisdictionRegistry is LabxRoles, EIP712, ILabxJurisdictionRegistry {
    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("CountryAttestation(address user,bytes2 country,uint64 issuedAt,uint64 deadline)");

    /// @notice Master switch. False by default.
    bool public gatesEnabled;
    /// @notice When true the registry is an allow-list; when false it is a deny-list.
    bool public allowlistMode;
    /// @notice How long a country attestation stays valid.
    uint64 public attestationTtl = 180 days;
    /// @notice When gates are on, require a fresh attestation rather than defaulting to "allowed".
    bool public attestationRequired = true;

    mapping(bytes2 country => bool) public countryAllowed;
    mapping(bytes2 country => bool) public countryBlocked;
    mapping(address user => bytes2) public attestedCountry;
    mapping(address user => uint64) public attestedUntil;
    mapping(address user => bool) public addressBlocked;

    event GatesToggled(bool enabled);
    event AllowlistModeToggled(bool allowlistMode);
    event AttestationRequirementToggled(bool required);
    event AttestationTtlUpdated(uint64 ttl);
    event CountryAllowed(bytes2 indexed country, bool allowed);
    event CountryBlocked(bytes2 indexed country, bool blocked);
    event AddressBlocked(address indexed user, bool blocked);
    event CountryAttested(address indexed user, bytes2 country, uint64 validUntil);

    error AttestationExpired();
    error InvalidAttestor();
    error ZeroCountry();
    error Blocked(address user);
    error NoAttestation(address user);
    error CountryNotPermitted(bytes2 country);

    constructor(address admin) LabxRoles(admin) EIP712("LABx Jurisdiction", "1") {}

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    function setGatesEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        gatesEnabled = enabled;
        emit GatesToggled(enabled);
    }

    function setAllowlistMode(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowlistMode = enabled;
        emit AllowlistModeToggled(enabled);
    }

    function setAttestationRequired(bool required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        attestationRequired = required;
        emit AttestationRequirementToggled(required);
    }

    function setAttestationTtl(uint64 ttl) external onlyRole(DEFAULT_ADMIN_ROLE) {
        attestationTtl = ttl;
        emit AttestationTtlUpdated(ttl);
    }

    function setCountryAllowed(bytes2 country, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (country == bytes2(0)) revert ZeroCountry();
        countryAllowed[country] = allowed;
        emit CountryAllowed(country, allowed);
    }

    function setCountryBlocked(bytes2 country, bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (country == bytes2(0)) revert ZeroCountry();
        countryBlocked[country] = blocked;
        emit CountryBlocked(country, blocked);
    }

    /// @notice Hard block for sanctions / abuse. Applies even when gates are off.
    function setAddressBlocked(address user, bool blocked) external onlyRole(DEFAULT_ADMIN_ROLE) {
        addressBlocked[user] = blocked;
        emit AddressBlocked(user, blocked);
    }

    // --------------------------------------------------------------------------------------------
    // Attestations
    // --------------------------------------------------------------------------------------------

    /// @notice Records an ISO-3166-1 alpha-2 country for `user`, signed by an `ATTESTOR_ROLE` key.
    /// @dev Anyone may relay the attestation; the signature binds the subject so LABx can pay the gas.
    function attest(address user, bytes2 country, uint64 issuedAt, uint64 deadline, bytes calldata signature)
        external
    {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (country == bytes2(0)) revert ZeroCountry();

        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, user, country, issuedAt, deadline));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (!hasRole(ATTESTOR_ROLE, signer)) revert InvalidAttestor();

        uint64 validUntil = uint64(block.timestamp) + attestationTtl;
        attestedCountry[user] = country;
        attestedUntil[user] = validUntil;
        emit CountryAttested(user, country, validUntil);
    }

    // --------------------------------------------------------------------------------------------
    // Checks
    // --------------------------------------------------------------------------------------------

    function isAllowed(address user) public view returns (bool) {
        if (addressBlocked[user]) return false;
        if (!gatesEnabled) return true;

        bytes2 country = attestedCountry[user];
        bool fresh = attestedUntil[user] >= block.timestamp;
        if (!fresh || country == bytes2(0)) return !attestationRequired;

        if (countryBlocked[country]) return false;
        if (allowlistMode) return countryAllowed[country];
        return true;
    }

    function requireAllowed(address user) external view {
        if (addressBlocked[user]) revert Blocked(user);
        if (!gatesEnabled) return;

        bytes2 country = attestedCountry[user];
        bool fresh = attestedUntil[user] >= block.timestamp;
        if (!fresh || country == bytes2(0)) {
            if (attestationRequired) revert NoAttestation(user);
            return;
        }
        if (countryBlocked[country]) revert CountryNotPermitted(country);
        if (allowlistMode && !countryAllowed[country]) revert CountryNotPermitted(country);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
