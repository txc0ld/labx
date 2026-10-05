// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ILabxMembership
/// @notice Entry ledger + membership tier surface consumed by the raffle house and the perks marketplace.
interface ILabxMembership {
    struct Tier {
        string name;
        uint96 priceUsdc; // 6-decimal USDC
        uint32 entries; // bonus entries granted per purchase
        uint16 discountBps; // headline perk discount, surfaced in the marketplace
        uint8 rank; // 1 = Entry ... n = Platinum; used for perk gating
        bool active;
    }

    struct EntryBatch {
        uint64 purchasedAt;
        uint64 expiresAt;
        uint32 total;
        uint32 spent;
        uint32 expired;
        uint96 valuePerEntry; // 0 for free / AMOE / points entries
    }

    struct MemberStatus {
        uint8 tierId;
        uint8 rank;
        uint64 purchasedAt;
        uint64 expiresAt;
    }

    /// @notice Spends `count` entries from `user`, oldest batch first, and transfers the backing USDC to the caller.
    /// @return value Total USDC value carried by the spent entries (the amount added to a raffle pot).
    /// @return freeCount How many of the spent entries were zero-value (free / AMOE / points) entries.
    /// @return earliestExpiry The earliest expiry among the spent batches, used to restore entries on a refund.
    function spendEntries(address user, uint32 count)
        external
        returns (uint256 value, uint32 freeCount, uint64 earliestExpiry);

    /// @notice Restores previously spent entries, pulling `value` USDC back from the caller.
    function refundEntries(address user, uint32 paidCount, uint32 freeCount, uint256 value, uint64 expiresAt)
        external;

    /// @notice Mints zero-value entries (AMOE points redemption, allowlist bonus, goodwill).
    function creditFreeEntries(address user, uint32 count, bytes32 reason) external;

    /// @notice Buys `tierId` for `user` with USDC pulled from `user`. Caller must hold `PURCHASE_ROUTER_ROLE`.
    function purchaseForWithUsdc(address user, uint8 tierId) external returns (uint32 entriesGranted);

    /// @notice Buys `tierId` for `user` with ETH forwarded by the caller. Caller must hold `PURCHASE_ROUTER_ROLE`.
    function purchaseForWithEth(address user, uint8 tierId, uint256 maxEthIn)
        external
        payable
        returns (uint32 entriesGranted);

    function entriesAvailable(address user) external view returns (uint32);

    function memberRank(address user) external view returns (uint8);

    function tierCount() external view returns (uint256);

    function tiers(uint256 tierId) external view returns (Tier memory);
}
