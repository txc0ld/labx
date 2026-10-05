// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxMembership} from "./interfaces/ILabxMembership.sol";
import {ILabxTerms} from "./interfaces/ILabxTerms.sol";
import {ILabxJurisdictionRegistry} from "./interfaces/ILabxJurisdictionRegistry.sol";
import {ILabxSwapAdapter} from "./interfaces/ILabxSwapAdapter.sol";

/// @title LabxMembership
/// @notice Platform-wide membership tiers and the entry ledger that backs every LABx raffle.
///
/// @dev Economics, in one place:
///      - Tiers are priced in USDC (6 decimals) and are fully admin-configurable (Entry -> Platinum).
///      - A buyer pays `tier.priceUsdc + membershipFeeUsdc`. The flat membership fee (5 USDC by default)
///        goes straight to the platform treasury and is the only platform-only cut at purchase time.
///      - The tier price is retained by this contract as *entry value*: `tier.entries` bonus entries are
///        credited, each carrying `priceUsdc / entries` USDC. Spending an entry moves that USDC into the
///        raffle's pot, which is what the seller is ultimately paid from (minus the platform fee).
///      - Entries are platform-wide, so a member can split one purchase across several raffles.
///      - Unused entries expire 12 months after purchase. There is no cash refund: the backing USDC is
///        transferred to the treasury when an expired batch is swept.
contract LabxMembership is LabxRoles, Pausable, ReentrancyGuard, ILabxMembership {
    using SafeERC20 for IERC20;

    uint64 public constant MIN_ENTRY_VALIDITY = 30 days;
    uint64 public constant MAX_ENTRY_VALIDITY = 1_095 days;
    uint96 public constant MAX_MEMBERSHIP_FEE_USDC = 100e6;

    IERC20 public immutable usdc;

    address public treasury;
    ILabxTerms public terms;
    ILabxJurisdictionRegistry public jurisdiction;
    ILabxSwapAdapter public swapAdapter;

    /// @notice Flat fee added to every purchase; routed to the platform treasury only.
    uint96 public membershipFeeUsdc = 5e6;
    /// @notice How long credited entries remain spendable.
    uint64 public entryValidity = 365 days;
    /// @notice When true, buyers must have accepted the current required legal documents.
    bool public termsRequired = true;

    /// @notice USDC held by this contract that still backs unspent, unexpired entries.
    uint256 public escrowedEntryValue;

    Tier[] private _tiers;
    mapping(address user => EntryBatch[]) private _batches;
    mapping(address user => uint256) private _spendCursor;
    mapping(address user => MemberStatus) private _memberStatus;

    event TierAdded(uint8 indexed tierId, string name, uint96 priceUsdc, uint32 entries, uint8 rank);
    event TierUpdated(uint8 indexed tierId, string name, uint96 priceUsdc, uint32 entries, uint8 rank, bool active);
    event TierPurchased(
        address indexed member,
        address indexed payer,
        uint8 indexed tierId,
        uint32 entriesGranted,
        uint96 valuePerEntry,
        uint96 feeUsdc,
        bool paidWithEth,
        uint64 expiresAt
    );
    event FreeEntriesCredited(address indexed member, uint32 count, bytes32 reason, uint64 expiresAt);
    event EntriesSpent(address indexed member, address indexed spender, uint32 count, uint256 value, uint32 freeCount);
    event EntriesRefunded(address indexed member, uint32 paidCount, uint32 freeCount, uint256 value, uint64 expiresAt);
    event EntriesExpired(address indexed member, uint256 indexed batchId, uint32 count, uint256 valueToTreasury);
    event TreasuryUpdated(address indexed treasury);
    event MembershipFeeUpdated(uint96 feeUsdc);
    event EntryValidityUpdated(uint64 validity);
    event TermsRequirementUpdated(bool required);
    event SwapAdapterUpdated(address indexed adapter);
    event TermsRegistryUpdated(address indexed registry);
    event JurisdictionRegistryUpdated(address indexed registry);
    event DustSweptToTreasury(uint256 amount, bytes32 reason);

    error UnknownTier(uint8 tierId);
    error TierInactive(uint8 tierId);
    error InvalidTier();
    error TooManyTiers();
    error ZeroEntries();
    error InsufficientEntries(uint32 requested, uint32 available);
    error BatchNotExpired(uint256 batchId);
    error UnknownBatch(uint256 batchId);
    error InvalidEntryValidity();
    error InvalidMembershipFee();
    error SwapAdapterNotSet();
    error EthCostAboveLimit(uint256 spent, uint256 limit);
    error NothingToRescue();

    constructor(address admin, address usdc_, address treasury_) LabxRoles(admin) {
        if (usdc_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    // --------------------------------------------------------------------------------------------
    // Admin: tiers
    // --------------------------------------------------------------------------------------------

    function addTier(string calldata name, uint96 priceUsdc, uint32 entries, uint16 discountBps, uint8 rank)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint8 tierId)
    {
        if (entries == 0 || priceUsdc == 0 || rank == 0 || discountBps > 10_000) revert InvalidTier();
        if (priceUsdc < entries) revert InvalidTier(); // every entry must carry at least 1 USDC unit
        if (_tiers.length >= 255) revert TooManyTiers();

        tierId = uint8(_tiers.length);
        _tiers.push(
            Tier({
                name: name,
                priceUsdc: priceUsdc,
                entries: entries,
                discountBps: discountBps,
                rank: rank,
                active: true
            })
        );
        emit TierAdded(tierId, name, priceUsdc, entries, rank);
    }

    function updateTier(
        uint8 tierId,
        string calldata name,
        uint96 priceUsdc,
        uint32 entries,
        uint16 discountBps,
        uint8 rank,
        bool active
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tierId >= _tiers.length) revert UnknownTier(tierId);
        if (entries == 0 || priceUsdc == 0 || rank == 0 || discountBps > 10_000) revert InvalidTier();
        if (priceUsdc < entries) revert InvalidTier();

        _tiers[tierId] = Tier({
            name: name,
            priceUsdc: priceUsdc,
            entries: entries,
            discountBps: discountBps,
            rank: rank,
            active: active
        });
        emit TierUpdated(tierId, name, priceUsdc, entries, rank, active);
    }

    // --------------------------------------------------------------------------------------------
    // Admin: configuration
    // --------------------------------------------------------------------------------------------

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setMembershipFee(uint96 feeUsdc) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeUsdc > MAX_MEMBERSHIP_FEE_USDC) revert InvalidMembershipFee();
        membershipFeeUsdc = feeUsdc;
        emit MembershipFeeUpdated(feeUsdc);
    }

    /// @dev Only affects entries credited after the change; existing batches keep their expiry.
    function setEntryValidity(uint64 validity) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (validity < MIN_ENTRY_VALIDITY || validity > MAX_ENTRY_VALIDITY) revert InvalidEntryValidity();
        entryValidity = validity;
        emit EntryValidityUpdated(validity);
    }

    function setTermsRequired(bool required) external onlyRole(DEFAULT_ADMIN_ROLE) {
        termsRequired = required;
        emit TermsRequirementUpdated(required);
    }

    function setTerms(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        terms = ILabxTerms(registry);
        emit TermsRegistryUpdated(registry);
    }

    function setJurisdiction(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        jurisdiction = ILabxJurisdictionRegistry(registry);
        emit JurisdictionRegistryUpdated(registry);
    }

    function setSwapAdapter(address adapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        swapAdapter = ILabxSwapAdapter(adapter);
        emit SwapAdapterUpdated(adapter);
    }

    function pause() external onlyRole(OPERATIONS_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraws only USDC that is *not* backing member entries, plus any unrelated token.
    function rescueTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(usdc)) {
            uint256 free = usdc.balanceOf(address(this)) - escrowedEntryValue;
            if (amount > free) revert NothingToRescue();
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // --------------------------------------------------------------------------------------------
    // Purchasing
    // --------------------------------------------------------------------------------------------

    /// @notice Buys `tierId` paying USDC. Requires a USDC allowance of `quoteTierTotal(tierId)`.
    function purchaseWithUsdc(uint8 tierId) external whenNotPaused nonReentrant returns (uint32) {
        return _purchaseWithUsdc(msg.sender, msg.sender, tierId);
    }

    /// @notice Buys `tierId` paying ETH, swapped to USDC atomically.
    /// @param maxEthIn Caller-side ceiling on ETH consumed; 0 means "oracle bound only".
    function purchaseWithEth(uint8 tierId, uint256 maxEthIn)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint32)
    {
        return _purchaseWithEth(msg.sender, tierId, maxEthIn, msg.sender);
    }

    /// @inheritdoc ILabxMembership
    function purchaseForWithUsdc(address user, uint8 tierId)
        external
        onlyRole(PURCHASE_ROUTER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint32)
    {
        return _purchaseWithUsdc(user, user, tierId);
    }

    /// @inheritdoc ILabxMembership
    function purchaseForWithEth(address user, uint8 tierId, uint256 maxEthIn)
        external
        payable
        onlyRole(PURCHASE_ROUTER_ROLE)
        whenNotPaused
        nonReentrant
        returns (uint32)
    {
        return _purchaseWithEth(user, tierId, maxEthIn, user);
    }

    function _purchaseWithUsdc(address member, address payer, uint8 tierId) private returns (uint32) {
        Tier memory tier = _requireActiveTier(tierId);
        _requireEligible(member);

        uint256 fee = membershipFeeUsdc;
        usdc.safeTransferFrom(payer, address(this), uint256(tier.priceUsdc) + fee);
        if (fee != 0) usdc.safeTransfer(treasury, fee);

        return _creditTier(member, payer, tierId, tier, false);
    }

    function _purchaseWithEth(address member, uint8 tierId, uint256 maxEthIn, address refundTo)
        private
        returns (uint32)
    {
        ILabxSwapAdapter adapter = swapAdapter;
        if (address(adapter) == address(0)) revert SwapAdapterNotSet();

        Tier memory tier = _requireActiveTier(tierId);
        _requireEligible(member);

        uint256 fee = membershipFeeUsdc;
        uint256 usdcNeeded = uint256(tier.priceUsdc) + fee;

        uint256 ethSpent = adapter.swapEthForExactUsdc{value: msg.value}(usdcNeeded, address(this), refundTo);
        if (maxEthIn != 0 && ethSpent > maxEthIn) revert EthCostAboveLimit(ethSpent, maxEthIn);

        if (fee != 0) usdc.safeTransfer(treasury, fee);

        return _creditTier(member, msg.sender, tierId, tier, true);
    }

    function _creditTier(address member, address payer, uint8 tierId, Tier memory tier, bool paidWithEth)
        private
        returns (uint32 entries)
    {
        entries = tier.entries;
        uint96 valuePerEntry = uint96(uint256(tier.priceUsdc) / entries);
        uint256 backed = uint256(valuePerEntry) * entries;

        escrowedEntryValue += backed;

        uint256 dust = uint256(tier.priceUsdc) - backed;
        if (dust != 0) {
            usdc.safeTransfer(treasury, dust);
            emit DustSweptToTreasury(dust, "tier-rounding");
        }

        uint64 expiresAt = uint64(block.timestamp) + entryValidity;
        _batches[member].push(
            EntryBatch({
                purchasedAt: uint64(block.timestamp),
                expiresAt: expiresAt,
                total: entries,
                spent: 0,
                expired: 0,
                valuePerEntry: valuePerEntry
            })
        );

        MemberStatus storage status = _memberStatus[member];
        if (tier.rank >= status.rank || status.expiresAt < block.timestamp) {
            status.tierId = tierId;
            status.rank = tier.rank;
        }
        status.purchasedAt = uint64(block.timestamp);
        if (expiresAt > status.expiresAt) status.expiresAt = expiresAt;

        emit TierPurchased(
            member, payer, tierId, entries, valuePerEntry, membershipFeeUsdc, paidWithEth, expiresAt
        );
    }

    // --------------------------------------------------------------------------------------------
    // Entry ledger
    // --------------------------------------------------------------------------------------------

    /// @inheritdoc ILabxMembership
    function spendEntries(address user, uint32 count)
        external
        onlyRole(ENTRY_SPENDER_ROLE)
        whenNotPaused
        returns (uint256 value, uint32 freeCount, uint64 earliestExpiry)
    {
        if (count == 0) revert ZeroEntries();

        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        uint256 index = _spendCursor[user];
        uint32 remaining = count;
        earliestExpiry = type(uint64).max;

        while (remaining != 0 && index < length) {
            EntryBatch storage batch = batches[index];
            uint32 available = batch.total - batch.spent - batch.expired;
            if (available == 0 || batch.expiresAt <= block.timestamp) {
                ++index;
                continue;
            }

            uint32 take = available < remaining ? available : remaining;
            batch.spent += take;
            remaining -= take;

            if (batch.valuePerEntry == 0) {
                freeCount += take;
            } else {
                value += uint256(batch.valuePerEntry) * take;
            }
            if (batch.expiresAt < earliestExpiry) earliestExpiry = batch.expiresAt;

            if (take == available) ++index;
        }

        if (remaining != 0) revert InsufficientEntries(count, count - remaining);
        _spendCursor[user] = index;

        if (value != 0) {
            escrowedEntryValue -= value;
            usdc.safeTransfer(msg.sender, value);
        }

        emit EntriesSpent(user, msg.sender, count, value, freeCount);
    }

    /// @inheritdoc ILabxMembership
    /// @dev Used when a raffle is cancelled or abandoned. `expiresAt` is the earliest expiry of the
    ///      originally spent batches, so a refund can never extend an entry's 12-month life. Pass 0 for
    ///      entries that never came from this ledger (AMOE / allowlist bonus entries added directly to a
    ///      raffle); those are re-issued with a fresh validity period.
    function refundEntries(address user, uint32 paidCount, uint32 freeCount, uint256 value, uint64 expiresAt)
        external
        onlyRole(ENTRY_SPENDER_ROLE)
    {
        if (value != 0) {
            usdc.safeTransferFrom(msg.sender, address(this), value);
        }
        if (expiresAt == 0) expiresAt = uint64(block.timestamp) + entryValidity;

        if (expiresAt <= block.timestamp) {
            // The entries would already be dead; the value follows the normal expiry path.
            if (value != 0) {
                usdc.safeTransfer(treasury, value);
                emit DustSweptToTreasury(value, "refund-after-expiry");
            }
            if (freeCount != 0) emit EntriesRefunded(user, 0, 0, 0, expiresAt);
            return;
        }

        if (paidCount != 0) {
            uint96 valuePerEntry = uint96(value / paidCount);
            uint256 backed = uint256(valuePerEntry) * paidCount;
            escrowedEntryValue += backed;
            _batches[user].push(
                EntryBatch({
                    purchasedAt: uint64(block.timestamp),
                    expiresAt: expiresAt,
                    total: paidCount,
                    spent: 0,
                    expired: 0,
                    valuePerEntry: valuePerEntry
                })
            );
            uint256 dust = value - backed;
            if (dust != 0) {
                usdc.safeTransfer(treasury, dust);
                emit DustSweptToTreasury(dust, "refund-rounding");
            }
        } else if (value != 0) {
            usdc.safeTransfer(treasury, value);
            emit DustSweptToTreasury(value, "refund-without-entries");
        }

        if (freeCount != 0) {
            _batches[user].push(
                EntryBatch({
                    purchasedAt: uint64(block.timestamp),
                    expiresAt: expiresAt,
                    total: freeCount,
                    spent: 0,
                    expired: 0,
                    valuePerEntry: 0
                })
            );
        }

        _resetCursorIfNeeded(user);
        emit EntriesRefunded(user, paidCount, freeCount, value, expiresAt);
    }

    /// @inheritdoc ILabxMembership
    function creditFreeEntries(address user, uint32 count, bytes32 reason)
        external
        onlyRole(ENTRY_ISSUER_ROLE)
        whenNotPaused
    {
        if (count == 0) revert ZeroEntries();
        uint64 expiresAt = uint64(block.timestamp) + entryValidity;
        _batches[user].push(
            EntryBatch({
                purchasedAt: uint64(block.timestamp),
                expiresAt: expiresAt,
                total: count,
                spent: 0,
                expired: 0,
                valuePerEntry: 0
            })
        );
        _resetCursorIfNeeded(user);
        emit FreeEntriesCredited(user, count, reason, expiresAt);
    }

    /// @notice Sweeps expired entry batches. Permissionless so a keeper (or anyone) can finalise them.
    /// @dev No cash refund is possible: the backing USDC is transferred to the platform treasury.
    function expireBatches(address user, uint256[] calldata batchIds) external {
        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        uint256 swept;

        for (uint256 i; i < batchIds.length; ++i) {
            uint256 batchId = batchIds[i];
            if (batchId >= length) revert UnknownBatch(batchId);

            EntryBatch storage batch = batches[batchId];
            if (batch.expiresAt > block.timestamp) revert BatchNotExpired(batchId);

            uint32 available = batch.total - batch.spent - batch.expired;
            if (available == 0) continue;

            batch.expired += available;
            uint256 value = uint256(batch.valuePerEntry) * available;
            swept += value;
            emit EntriesExpired(user, batchId, available, value);
        }

        if (swept != 0) {
            escrowedEntryValue -= swept;
            usdc.safeTransfer(treasury, swept);
        }
    }

    /// @dev A refund or credit can add spendable entries behind the cursor; rewind so they are reachable.
    function _resetCursorIfNeeded(address user) private {
        uint256 cursor = _spendCursor[user];
        uint256 length = _batches[user].length;
        if (cursor >= length) {
            _spendCursor[user] = length - 1;
        }
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    function tierCount() external view returns (uint256) {
        return _tiers.length;
    }

    function tiers(uint256 tierId) external view returns (Tier memory) {
        if (tierId >= _tiers.length) revert UnknownTier(uint8(tierId));
        return _tiers[tierId];
    }

    function allTiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    /// @notice Total USDC a buyer pays for `tierId`, inclusive of the flat membership fee.
    function quoteTierTotal(uint8 tierId) external view returns (uint256) {
        if (tierId >= _tiers.length) revert UnknownTier(tierId);
        return uint256(_tiers[tierId].priceUsdc) + membershipFeeUsdc;
    }

    function memberStatus(address user) external view returns (MemberStatus memory) {
        return _memberStatus[user];
    }

    /// @inheritdoc ILabxMembership
    function memberRank(address user) external view returns (uint8) {
        MemberStatus memory status = _memberStatus[user];
        if (status.expiresAt < block.timestamp) return 0;
        return status.rank;
    }

    /// @inheritdoc ILabxMembership
    function entriesAvailable(address user) public view returns (uint32 total) {
        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        for (uint256 i; i < length; ++i) {
            EntryBatch storage batch = batches[i];
            if (batch.expiresAt <= block.timestamp) continue;
            total += batch.total - batch.spent - batch.expired;
        }
    }

    /// @notice Spendable entries split into value-carrying and free (AMOE / points / allowlist) entries.
    function entriesBreakdown(address user) external view returns (uint32 paid, uint32 free, uint256 value) {
        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        for (uint256 i; i < length; ++i) {
            EntryBatch storage batch = batches[i];
            if (batch.expiresAt <= block.timestamp) continue;
            uint32 available = batch.total - batch.spent - batch.expired;
            if (available == 0) continue;
            if (batch.valuePerEntry == 0) {
                free += available;
            } else {
                paid += available;
                value += uint256(batch.valuePerEntry) * available;
            }
        }
    }

    function batchCount(address user) external view returns (uint256) {
        return _batches[user].length;
    }

    function batchAt(address user, uint256 batchId) external view returns (EntryBatch memory) {
        if (batchId >= _batches[user].length) revert UnknownBatch(batchId);
        return _batches[user][batchId];
    }

    function allBatches(address user) external view returns (EntryBatch[] memory) {
        return _batches[user];
    }

    function spendCursor(address user) external view returns (uint256) {
        return _spendCursor[user];
    }

    /// @notice Batch ids that are past their expiry and still hold entries; input for `expireBatches`.
    function expirableBatchIds(address user) external view returns (uint256[] memory ids, uint256 value) {
        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        uint256[] memory buffer = new uint256[](length);
        uint256 count;
        for (uint256 i; i < length; ++i) {
            EntryBatch storage batch = batches[i];
            if (batch.expiresAt > block.timestamp) continue;
            uint32 available = batch.total - batch.spent - batch.expired;
            if (available == 0) continue;
            buffer[count++] = i;
            value += uint256(batch.valuePerEntry) * available;
        }
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = buffer[i];
        }
    }

    /// @notice Earliest expiry across the member's spendable entries; 0 when they hold none.
    ///         Drives the quarterly "your entries expire soon" email.
    function nextExpiry(address user) external view returns (uint64 expiresAt, uint32 entries) {
        EntryBatch[] storage batches = _batches[user];
        uint256 length = batches.length;
        uint64 earliest = type(uint64).max;
        for (uint256 i; i < length; ++i) {
            EntryBatch storage batch = batches[i];
            if (batch.expiresAt <= block.timestamp) continue;
            uint32 available = batch.total - batch.spent - batch.expired;
            if (available == 0) continue;
            if (batch.expiresAt < earliest) {
                earliest = batch.expiresAt;
                entries = available;
            } else if (batch.expiresAt == earliest) {
                entries += available;
            }
        }
        expiresAt = earliest == type(uint64).max ? 0 : earliest;
    }

    function _requireActiveTier(uint8 tierId) private view returns (Tier memory tier) {
        if (tierId >= _tiers.length) revert UnknownTier(tierId);
        tier = _tiers[tierId];
        if (!tier.active) revert TierInactive(tierId);
    }

    function _requireEligible(address user) private view {
        if (termsRequired && address(terms) != address(0)) terms.requireAccepted(user);
        if (address(jurisdiction) != address(0)) jurisdiction.requireAllowed(user);
    }
}
