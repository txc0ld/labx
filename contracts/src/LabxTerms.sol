// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxTerms} from "./interfaces/ILabxTerms.sol";

/// @title LabxTerms
/// @notice Versioned legal document registry plus the record of each wallet's "I agree" acceptance.
/// @dev Every tick-box in the UI maps to a document key (e.g. `keccak256("TERMS_OF_USE")`). Publishing new
///      wording bumps that key's version, which immediately invalidates prior acceptances for required
///      documents, so members re-agree before their next purchase or entry.
contract LabxTerms is LabxRoles, EIP712, ILabxTerms {
    bytes32 public constant TERMS_OF_USE = keccak256("LABX_TERMS_OF_USE");
    bytes32 public constant RAFFLE_RULES = keccak256("LABX_RAFFLE_RULES");
    bytes32 public constant PRIVACY_POLICY = keccak256("LABX_PRIVACY_POLICY");
    bytes32 public constant ENTRY_EXPIRY_DISCLOSURE = keccak256("LABX_ENTRY_EXPIRY_DISCLOSURE");

    bytes32 private constant ACCEPT_TERMS_TYPEHASH = keccak256(
        "AcceptTerms(address user,bytes32[] keys,uint32[] versions,uint256 nonce,uint64 deadline)"
    );

    mapping(bytes32 key => uint32) private _currentVersion;
    mapping(bytes32 key => mapping(uint32 version => Document)) private _documents;
    mapping(address user => mapping(bytes32 key => uint32)) private _acceptedVersion;
    mapping(address user => mapping(bytes32 key => uint64)) private _acceptedAt;
    mapping(address user => uint256) public acceptanceNonce;

    bytes32[] private _requiredKeys;
    mapping(bytes32 key => uint256) private _requiredKeyIndex; // 1-based; 0 == not required

    event DocumentPublished(bytes32 indexed key, uint32 version, bytes32 contentHash, string uri);
    event DocumentRequirementChanged(bytes32 indexed key, bool required);
    event TermsAccepted(address indexed user, bytes32 indexed key, uint32 version, uint64 acceptedAt);

    error EmptyUri();
    error ZeroContentHash();
    error UnknownDocument(bytes32 key);
    error LengthMismatch();
    error StaleVersion(bytes32 key, uint32 submitted, uint32 current);
    error TermsNotAccepted(address user, bytes32 key);
    error SignatureExpired();
    error InvalidSignature();

    constructor(address admin) LabxRoles(admin) EIP712("LABx Terms", "1") {}

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    /// @notice Publishes new wording for `key` and returns the new version number.
    function publish(bytes32 key, string calldata uri, bytes32 contentHash)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint32 version)
    {
        if (bytes(uri).length == 0) revert EmptyUri();
        if (contentHash == bytes32(0)) revert ZeroContentHash();

        version = _currentVersion[key] + 1;
        _currentVersion[key] = version;
        _documents[key][version] =
            Document({version: version, publishedAt: uint64(block.timestamp), contentHash: contentHash, uri: uri});

        emit DocumentPublished(key, version, contentHash, uri);
    }

    /// @notice Adds or removes `key` from the set of documents a member must accept.
    function setRequired(bytes32 key, bool required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (required) {
            if (_currentVersion[key] == 0) revert UnknownDocument(key);
            if (_requiredKeyIndex[key] == 0) {
                _requiredKeys.push(key);
                _requiredKeyIndex[key] = _requiredKeys.length;
            }
        } else {
            uint256 index = _requiredKeyIndex[key];
            if (index != 0) {
                uint256 last = _requiredKeys.length;
                if (index != last) {
                    bytes32 moved = _requiredKeys[last - 1];
                    _requiredKeys[index - 1] = moved;
                    _requiredKeyIndex[moved] = index;
                }
                _requiredKeys.pop();
                _requiredKeyIndex[key] = 0;
            }
        }
        emit DocumentRequirementChanged(key, required);
    }

    // --------------------------------------------------------------------------------------------
    // Acceptance
    // --------------------------------------------------------------------------------------------

    /// @notice Records the caller's acceptance of the current version of each supplied document.
    function accept(bytes32[] calldata keys, uint32[] calldata versions) external {
        _accept(msg.sender, keys, versions);
    }

    /// @notice Relayed acceptance so LABx can pay the gas for a member's tick-box consent.
    function acceptWithSignature(
        address user,
        bytes32[] calldata keys,
        uint32[] calldata versions,
        uint64 deadline,
        bytes calldata signature
    ) external {
        if (block.timestamp > deadline) revert SignatureExpired();

        uint256 nonce = acceptanceNonce[user];
        bytes32 structHash = keccak256(
            abi.encode(ACCEPT_TERMS_TYPEHASH, user, _hashKeys(keys), _hashVersions(versions), nonce, deadline)
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != user) revert InvalidSignature();

        acceptanceNonce[user] = nonce + 1;
        _accept(user, keys, versions);
    }

    function _accept(address user, bytes32[] calldata keys, uint32[] calldata versions) private {
        uint256 length = keys.length;
        if (length != versions.length) revert LengthMismatch();

        for (uint256 i; i < length; ++i) {
            bytes32 key = keys[i];
            uint32 current = _currentVersion[key];
            if (current == 0) revert UnknownDocument(key);
            if (versions[i] != current) revert StaleVersion(key, versions[i], current);

            _acceptedVersion[user][key] = current;
            _acceptedAt[user][key] = uint64(block.timestamp);
            emit TermsAccepted(user, key, current, uint64(block.timestamp));
        }
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    function currentVersion(bytes32 key) external view returns (uint32) {
        return _currentVersion[key];
    }

    function acceptedVersion(address user, bytes32 key) external view returns (uint32) {
        return _acceptedVersion[user][key];
    }

    function acceptedAt(address user, bytes32 key) external view returns (uint64) {
        return _acceptedAt[user][key];
    }

    function document(bytes32 key, uint32 version) external view returns (Document memory) {
        return _documents[key][version];
    }

    function requiredKeys() external view returns (bytes32[] memory) {
        return _requiredKeys;
    }

    function hasAcceptedAll(address user) public view returns (bool) {
        uint256 length = _requiredKeys.length;
        for (uint256 i; i < length; ++i) {
            bytes32 key = _requiredKeys[i];
            if (_acceptedVersion[user][key] != _currentVersion[key]) return false;
        }
        return true;
    }

    /// @notice The required documents `user` still has to accept (or re-accept after a version bump).
    function pendingKeys(address user) external view returns (bytes32[] memory pending) {
        uint256 length = _requiredKeys.length;
        bytes32[] memory buffer = new bytes32[](length);
        uint256 count;
        for (uint256 i; i < length; ++i) {
            bytes32 key = _requiredKeys[i];
            if (_acceptedVersion[user][key] != _currentVersion[key]) {
                buffer[count++] = key;
            }
        }
        pending = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            pending[i] = buffer[i];
        }
    }

    function requireAccepted(address user) external view {
        uint256 length = _requiredKeys.length;
        for (uint256 i; i < length; ++i) {
            bytes32 key = _requiredKeys[i];
            if (_acceptedVersion[user][key] != _currentVersion[key]) revert TermsNotAccepted(user, key);
        }
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _hashKeys(bytes32[] calldata keys) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(keys));
    }

    /// @dev EIP-712 requires each array element padded to 32 bytes, so widen `uint32` before packing.
    function _hashVersions(uint32[] calldata versions) private pure returns (bytes32) {
        uint256 length = versions.length;
        bytes memory encoded = new bytes(length * 32);
        for (uint256 i; i < length; ++i) {
            bytes32 word = bytes32(uint256(versions[i]));
            uint256 offset = 32 + (i * 32);
            // solhint-disable-next-line no-inline-assembly
            assembly {
                mstore(add(encoded, offset), word)
            }
        }
        return keccak256(encoded);
    }
}
