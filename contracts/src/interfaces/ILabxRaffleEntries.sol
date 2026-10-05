// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice How an entry reached a raffle. Recorded on every entry so the draw is auditable and so the
///         free (AMOE) routes can be told apart from purchased ones without re-reading the pot.
enum LabxEntryKind {
    MembershipPack, // bought as part of a membership pack in the same transaction
    LedgerBalance, // spent from the member's platform-wide entry balance
    FreeDirect, // AMOE: one free entry per person per raffle
    AllowlistBonus // past-holder bonus entries
}

/// @title ILabxRaffleEntries
/// @notice The slice of the raffle house that the AMOE gateway is allowed to use.
interface ILabxRaffleEntries {
    /// @notice Adds zero-value entries to a raffle. Restricted to `ENTRY_ISSUER_ROLE`.
    function creditFreeEntries(uint256 raffleId, address account, uint32 count, LabxEntryKind kind) external;

    /// @notice The entry rules the AMOE gateway needs in order to decide what it may issue.
    function raffleEntryRules(uint256 raffleId)
        external
        view
        returns (bool acceptingEntries, bool freeEntryEnabled, bytes32 allowlistRoot, uint32 allowlistBonusEntries);
}
