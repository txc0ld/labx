// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxRaffleEntries, LabxEntryKind} from "./interfaces/ILabxRaffleEntries.sol";

/// @title LabxAmoeGateway
/// @notice Every "no purchase necessary" route into a LABx raffle, in one auditable contract.
///
/// @dev Two routes, both carrying zero pot value and exactly the same draw weight as a purchased entry:
///
///      1. Direct free entry - one per person per raffle. Gated off-chain by a captcha (Cloudflare
///         Turnstile or hCaptcha) plus a wallet signature; the LABx API verifies both and then issues an
///         EIP-712 attestation from an `ATTESTOR_ROLE` key. Attestations are single-use and short-lived,
///         and anyone may relay one so LABx can pay the gas. This route is deliberately not marketed, but
///         it is always available and always weighted identically - see `docs/legal-notes.md`.
///
///      2. Past-holder allowlist bonus - a Merkle allowlist of previous holders of the prize collection,
///         each claimable once for `allowlistBonusEntries` free entries.
///
///      Points earned from bot-gated check-ins are handled by `LabxPoints`, which mints free entries into
///      the member's platform-wide balance rather than into one specific raffle.
contract LabxAmoeGateway is LabxRoles, EIP712 {
    bytes32 private constant FREE_ENTRY_TYPEHASH =
        keccak256("FreeEntry(address user,uint256 raffleId,bytes32 nonce,uint64 deadline)");

    ILabxRaffleEntries public immutable raffleHouse;

    mapping(uint256 raffleId => mapping(address account => bool)) public freeEntryClaimed;
    mapping(uint256 raffleId => mapping(address account => bool)) public allowlistClaimed;
    mapping(bytes32 nonce => bool) public nonceUsed;

    event FreeEntryIssued(uint256 indexed raffleId, address indexed account, bytes32 nonce);
    event AllowlistBonusIssued(uint256 indexed raffleId, address indexed account, uint32 entries);

    error AttestationExpired();
    error NonceAlreadyUsed(bytes32 nonce);
    error InvalidAttestor();
    error EntriesNotOpen(uint256 raffleId);
    error FreeEntryDisabled(uint256 raffleId);
    error FreeEntryAlreadyClaimed(uint256 raffleId, address account);
    error AllowlistUnavailable(uint256 raffleId);
    error AllowlistAlreadyClaimed(uint256 raffleId, address account);
    error InvalidProof();

    constructor(address admin, address raffleHouse_) LabxRoles(admin) EIP712("LABx AMOE", "1") {
        if (raffleHouse_ == address(0)) revert ZeroAddress();
        raffleHouse = ILabxRaffleEntries(raffleHouse_);
    }

    /// @notice Claims the single free entry available to `account` on `raffleId`.
    /// @param attestation EIP-712 `FreeEntry` signature from an `ATTESTOR_ROLE` key, issued by the LABx
    ///        API once it has verified the captcha token and the wallet signature for `account`.
    function claimFreeEntry(
        uint256 raffleId,
        address account,
        bytes32 nonce,
        uint64 deadline,
        bytes calldata attestation
    ) external {
        if (block.timestamp > deadline) revert AttestationExpired();
        if (nonceUsed[nonce]) revert NonceAlreadyUsed(nonce);

        // slither-disable-next-line unused-return  (the allowlist fields are irrelevant on this route)
        (bool acceptingEntries, bool freeEntryEnabled,,) = raffleHouse.raffleEntryRules(raffleId);
        if (!acceptingEntries) revert EntriesNotOpen(raffleId);
        if (!freeEntryEnabled) revert FreeEntryDisabled(raffleId);
        if (freeEntryClaimed[raffleId][account]) revert FreeEntryAlreadyClaimed(raffleId, account);

        bytes32 structHash = keccak256(abi.encode(FREE_ENTRY_TYPEHASH, account, raffleId, nonce, deadline));
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), attestation);
        if (!hasRole(ATTESTOR_ROLE, signer)) revert InvalidAttestor();

        nonceUsed[nonce] = true;
        freeEntryClaimed[raffleId][account] = true;

        raffleHouse.creditFreeEntries(raffleId, account, 1, LabxEntryKind.FreeDirect);
        emit FreeEntryIssued(raffleId, account, nonce);
    }

    /// @notice Claims the past-holder bonus entries for the caller.
    /// @dev Leaves are `keccak256(bytes.concat(keccak256(abi.encode(account))))`, matching the
    ///      double-hashed convention used by OpenZeppelin and merkletreejs.
    function claimAllowlistBonus(uint256 raffleId, bytes32[] calldata proof) external {
        // slither-disable-next-line unused-return  (the free-entry flag is irrelevant on this route)
        (bool acceptingEntries,, bytes32 root, uint32 bonus) = raffleHouse.raffleEntryRules(raffleId);
        if (!acceptingEntries) revert EntriesNotOpen(raffleId);
        if (bonus == 0 || root == bytes32(0)) revert AllowlistUnavailable(raffleId);
        if (allowlistClaimed[raffleId][msg.sender]) revert AllowlistAlreadyClaimed(raffleId, msg.sender);

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender))));
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert InvalidProof();

        allowlistClaimed[raffleId][msg.sender] = true;

        raffleHouse.creditFreeEntries(raffleId, msg.sender, bonus, LabxEntryKind.AllowlistBonus);
        emit AllowlistBonusIssued(raffleId, msg.sender, bonus);
    }

    /// @notice Whether `account` still has a free entry available on `raffleId`, and why not if it does not.
    function freeEntryAvailable(uint256 raffleId, address account) external view returns (bool ok, bytes32 reason) {
        // slither-disable-next-line unused-return
        (bool acceptingEntries, bool freeEntryEnabled,,) = raffleHouse.raffleEntryRules(raffleId);
        if (!acceptingEntries) return (false, "entries-closed");
        if (!freeEntryEnabled) return (false, "disabled-for-raffle");
        if (freeEntryClaimed[raffleId][account]) return (false, "already-claimed");
        return (true, bytes32(0));
    }

    function leafFor(address account) external pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
