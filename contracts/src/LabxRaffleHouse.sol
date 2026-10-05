// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {LabxRoles} from "./base/LabxRoles.sol";
import {LabxVRFConsumerBase} from "./base/LabxVRFConsumerBase.sol";
import {ILabxMembership} from "./interfaces/ILabxMembership.sol";
import {ILabxTerms} from "./interfaces/ILabxTerms.sol";
import {ILabxJurisdictionRegistry} from "./interfaces/ILabxJurisdictionRegistry.sol";
import {ILabxRaffleEntries, LabxEntryKind} from "./interfaces/ILabxRaffleEntries.sol";

/// @title LabxRaffleHouse
/// @notice Escrows an NFT, collects entries from the platform-wide LABx entry ledger, and draws a
///         winner with Chainlink VRF v2.5.
///
/// @dev Seller reserve is commit-reveal. At creation the contract stores only
///      `keccak256(abi.encode(reserveUsdc, salt))`; the plaintext reserve lives encrypted server-side and
///      is never written on-chain until close. At close, a role-gated call either reveals the reserve and
///      starts the draw (proving `pot >= reserve`) or reveals it and starts refunds (proving
///      `pot < reserve`). The commitment is immutable: there is no setter, so the operator cannot move the
///      reserve after entries have been sold. If the operator does nothing within `operatorActionWindow`
///      of close, anyone may force the refund path, so buyers are never trapped by a server outage.
contract LabxRaffleHouse is
    ILabxRaffleEntries,
    LabxRoles,
    EIP712,
    Pausable,
    ReentrancyGuard,
    ERC721Holder,
    ERC1155Holder,
    LabxVRFConsumerBase
{
    using SafeERC20 for IERC20;

    enum NftStandard {
        ERC721,
        ERC1155
    }

    enum RaffleStatus {
        None,
        Open, // accepting entries
        Closed, // entries frozen, awaiting operator reveal (or the next draw attempt)
        Drawing, // VRF request in flight
        Won, // winner selected, awaiting acceptance
        Delivered, // prize transferred and seller settled
        Refunding, // reserve not met / abandoned: NFT returned, entrants may pull entries back
        Cancelled // cancelled before any entry was sold
    }

    struct Raffle {
        address nft;
        NftStandard standard;
        bool freeEntryEnabled;
        bool settled;
        RaffleStatus status;
        uint64 opensAt;
        uint256 tokenId;
        address seller;
        uint64 endsAt;
        uint32 maxEntriesPerUser;
        address winner;
        uint64 claimDeadline;
        uint32 totalEntries;
        uint96 amount;
        uint64 closedAt;
        uint64 drawRequestedAt;
        uint32 allowlistBonusEntries;
        uint8 drawAttempts;
        bool reserveRevealed;
        bool prizeAccepted;
        uint256 pot;
        uint256 reserveUsdc;
        bytes32 reserveCommitment;
        bytes32 allowlistRoot;
        bytes32 entryCommitment;
        uint256 vrfRequestId;
    }

    struct CreateRaffleParams {
        address nft;
        uint256 tokenId;
        uint96 amount;
        NftStandard standard;
        address seller;
        uint64 opensAt;
        uint64 endsAt;
        uint32 maxEntriesPerUser;
        bytes32 reserveCommitment;
        bytes32 allowlistRoot;
        uint32 allowlistBonusEntries;
        bool freeEntryEnabled;
        string metadataUri;
    }

    struct EntrantRecord {
        uint32 paidEntries;
        uint32 freeEntries;
        uint128 value;
        uint64 earliestExpiry;
        bool refunded;
    }

    struct Segment {
        address account;
        uint32 cumulative;
    }

    struct Config {
        /// @notice Platform cut of a settled pot, in basis points. The seller receives the remainder.
        uint16 platformFeeBps;
        /// @notice How long a winner has to accept the prize before a redraw becomes possible.
        uint64 claimWindow;
        /// @notice Grace period after close (or a missed claim) before anyone may force refunds.
        uint64 operatorActionWindow;
        /// @notice Hard cap on entry segments per raffle, bounding the close/commit gas.
        uint32 maxSegmentsPerRaffle;
        /// @notice Maximum winner selections before the raffle is abandoned and entries refunded.
        uint8 maxDrawAttempts;
        /// @notice When true a seller may list without a curator. Off by default.
        bool permissionlessListing;
        /// @notice When true a curator-created listing needs the seller's EIP-712 signature over the
        ///         reserve commitment, so the operator cannot invent or alter a seller's reserve.
        bool sellerSignatureRequired;
    }

    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant MAX_PICK_ATTEMPTS = 64;

    bytes32 private constant LIST_RAFFLE_TYPEHASH = keccak256(
        "ListRaffle(address seller,address nft,uint256 tokenId,uint96 amount,uint8 standard,uint64 opensAt,uint64 endsAt,bytes32 reserveCommitment,uint256 nonce,uint64 deadline)"
    );

    IERC20 public immutable usdc;
    ILabxMembership public immutable membership;

    address public treasury;
    ILabxTerms public terms;
    ILabxJurisdictionRegistry public jurisdiction;

    /// @notice Raffle policy, changed in one multisig transaction so the parameters stay consistent.
    Config private _config;

    Raffle[] private _raffles;
    mapping(uint256 raffleId => string) public metadataUri;
    /// @notice Per-raffle entry segments in the order they were bought. `cumulative` is the running
    ///         entry weight, which is what the VRF word indexes into.
    // slither-disable-next-line uninitialized-state  (mappings have no initial value to assign)
    mapping(uint256 raffleId => Segment[]) public segments;
    mapping(uint256 raffleId => mapping(address account => EntrantRecord)) public entrants;
    mapping(uint256 raffleId => mapping(address account => bool)) public excludedFromDraw;
    mapping(uint256 requestId => uint256) private _requestToRaffle; // stored as raffleId + 1
    mapping(address seller => uint256) public listingNonce;
    mapping(address nft => mapping(uint256 tokenId => uint256)) private _escrowedBy; // raffleId + 1

    event RaffleCreated(
        uint256 indexed raffleId,
        address indexed seller,
        address indexed nft,
        uint256 tokenId,
        uint96 amount,
        NftStandard standard,
        uint64 opensAt,
        uint64 endsAt,
        bytes32 reserveCommitment,
        string metadataUri
    );
    event RaffleMetadataUpdated(uint256 indexed raffleId, string metadataUri);
    event EntriesAdded(
        uint256 indexed raffleId,
        address indexed account,
        LabxEntryKind kind,
        uint32 count,
        uint256 value,
        uint32 totalEntries,
        bytes32 entryCommitment
    );
    event EntriesCommitted(
        uint256 indexed raffleId, uint32 totalEntries, uint256 segmentCount, bytes32 entryCommitment
    );
    event ReserveRevealed(uint256 indexed raffleId, uint256 reserveUsdc, uint256 pot, bool met);
    event DrawRequested(uint256 indexed raffleId, uint256 requestId, uint8 attempt);
    event WinnerSelected(uint256 indexed raffleId, address indexed winner, uint256 requestId, uint64 claimDeadline);
    event DrawInconclusive(uint256 indexed raffleId, uint256 requestId);
    event PrizeAccepted(uint256 indexed raffleId, address indexed winner);
    event PrizeDelivered(uint256 indexed raffleId, address indexed winner, address deliveredBy);
    event RaffleSettled(uint256 indexed raffleId, address indexed seller, uint256 sellerProceeds, uint256 platformFee);
    event RefundStarted(uint256 indexed raffleId, bytes32 reason);
    event EntrantRefunded(uint256 indexed raffleId, address indexed account, uint32 paid, uint32 free, uint256 value);
    event WinnerExcluded(uint256 indexed raffleId, address indexed account, uint8 attempt);
    event RaffleCancelled(uint256 indexed raffleId);
    event ConfigUpdated(
        uint16 platformFeeBps,
        uint64 claimWindow,
        uint64 operatorActionWindow,
        uint32 maxSegmentsPerRaffle,
        uint8 maxDrawAttempts,
        bool permissionlessListing,
        bool sellerSignatureRequired
    );
    event TreasuryUpdated(address indexed treasury);
    event TermsRegistryUpdated(address indexed registry);
    event JurisdictionRegistryUpdated(address indexed registry);

    error UnknownRaffle(uint256 raffleId);
    error WrongStatus(RaffleStatus actual, RaffleStatus expected);
    error NotOpenYet(uint64 opensAt);
    error EntriesClosed(uint64 endsAt);
    error EntriesStillOpen(uint64 endsAt);
    error InvalidWindow();
    error InvalidAmount();
    error ZeroReserveCommitment();
    error ReserveAlreadyRevealed();
    error ReserveNotRevealed();
    error BadReserveReveal();
    error ReserveNotMet(uint256 pot, uint256 reserve);
    error ReserveMet(uint256 pot, uint256 reserve);
    error ZeroEntries();
    error PerUserLimit(uint32 limit);
    error SegmentLimit(uint32 limit);
    error NoEntries();
    error NotWinner(address caller);
    error PrizeNotAccepted();
    error ClaimWindowOpen(uint64 claimDeadline);
    error TimeoutNotReached(uint64 availableAt);
    error AlreadyRefunded();
    error NothingToRefund();
    error AllowlistBonusUnavailable();
    error AttestationExpired();
    error InvalidSellerSignature();
    error ListingNotPermitted();
    error TokenAlreadyEscrowed(address nft, uint256 tokenId);
    error TokenEscrowed(address nft, uint256 tokenId);
    error InvalidFee();
    error InvalidConfig();
    error DrawAttemptsExhausted();
    error PrizeAlreadyAccepted();

    constructor(
        address admin,
        address usdc_,
        address membership_,
        address treasury_,
        address vrfCoordinator_,
        VrfConfig memory vrfConfig_
    ) LabxRoles(admin) EIP712("LABx Raffle House", "1") LabxVRFConsumerBase(vrfCoordinator_, vrfConfig_) {
        if (usdc_ == address(0) || membership_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        membership = ILabxMembership(membership_);
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);

        _setConfig(
            Config({
                platformFeeBps: 1_000,
                claimWindow: 7 days,
                operatorActionWindow: 3 days,
                maxSegmentsPerRaffle: 50_000,
                maxDrawAttempts: 3,
                permissionlessListing: false,
                sellerSignatureRequired: true
            })
        );
    }

    // --------------------------------------------------------------------------------------------
    // Admin
    // --------------------------------------------------------------------------------------------

    /// @notice Replaces the whole raffle policy in a single transaction.
    function setConfig(Config calldata config_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setConfig(config_);
    }

    function _setConfig(Config memory config_) private {
        if (config_.platformFeeBps > 3_000) revert InvalidFee();
        if (config_.claimWindow < 1 days || config_.claimWindow > 90 days) revert InvalidWindow();
        if (config_.operatorActionWindow < 1 days || config_.operatorActionWindow > 30 days) {
            revert InvalidWindow();
        }
        if (config_.maxDrawAttempts == 0 || config_.maxSegmentsPerRaffle == 0) revert InvalidConfig();

        _config = config_;
        emit ConfigUpdated(
            config_.platformFeeBps,
            config_.claimWindow,
            config_.operatorActionWindow,
            config_.maxSegmentsPerRaffle,
            config_.maxDrawAttempts,
            config_.permissionlessListing,
            config_.sellerSignatureRequired
        );
    }

    function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasuryUpdated(treasury_);
    }

    function setTerms(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        terms = ILabxTerms(registry);
        emit TermsRegistryUpdated(registry);
    }

    function setJurisdiction(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        jurisdiction = ILabxJurisdictionRegistry(registry);
        emit JurisdictionRegistryUpdated(registry);
    }

    function setVrfCoordinator(address coordinator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setVrfCoordinator(coordinator);
    }

    function setVrfConfig(VrfConfig calldata vrfConfig_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setVrfConfig(vrfConfig_);
    }

    function pause() external onlyRole(OPERATIONS_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Returns an NFT that was sent here without being escrowed by a raffle.
    function rescueNft(address nft, uint256 tokenId, uint96 amount, NftStandard standard, address to)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert ZeroAddress();
        if (_escrowedBy[nft][tokenId] != 0) revert TokenEscrowed(nft, tokenId);
        _sendNft(nft, tokenId, amount, standard, to);
    }

    // --------------------------------------------------------------------------------------------
    // Listing
    // --------------------------------------------------------------------------------------------

    /// @notice Creates a raffle and escrows the prize NFT in this contract immediately.
    /// @dev The prize is held by the contract for the whole raffle - never an approval the seller could
    ///      revoke. `params.reserveCommitment` binds the seller's hidden reserve and can never change.
    /// @param sellerSignature EIP-712 `ListRaffle` signature from `params.seller`. Required when a
    ///        curator lists on a seller's behalf and `sellerSignatureRequired` is true.
    function createRaffle(CreateRaffleParams calldata params, uint64 signatureDeadline, bytes calldata sellerSignature)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 raffleId)
    {
        _validateCreate(params);
        _authorizeListing(params, signatureDeadline, sellerSignature);

        raffleId = _raffles.length;
        uint64 opensAt = params.opensAt == 0 ? uint64(block.timestamp) : params.opensAt;
        {
            Raffle storage raffle = _raffles.push();
            raffle.nft = params.nft;
            raffle.tokenId = params.tokenId;
            raffle.amount = params.amount;
            raffle.standard = params.standard;
            raffle.seller = params.seller;
            raffle.opensAt = opensAt;
            raffle.endsAt = params.endsAt;
            raffle.maxEntriesPerUser = params.maxEntriesPerUser;
            raffle.reserveCommitment = params.reserveCommitment;
            raffle.allowlistRoot = params.allowlistRoot;
            raffle.allowlistBonusEntries = params.allowlistBonusEntries;
            raffle.freeEntryEnabled = params.freeEntryEnabled;
            raffle.status = RaffleStatus.Open;
        }

        metadataUri[raffleId] = params.metadataUri;
        _escrowedBy[params.nft][params.tokenId] = raffleId + 1;

        _pullNft(params.nft, params.seller, params.tokenId, params.amount, params.standard);
        _emitCreated(raffleId, params, opensAt);
    }

    function _validateCreate(CreateRaffleParams calldata params) private view {
        if (params.seller == address(0) || params.nft == address(0)) revert ZeroAddress();
        if (params.reserveCommitment == bytes32(0)) revert ZeroReserveCommitment();
        if (params.endsAt <= params.opensAt || params.endsAt <= block.timestamp) revert InvalidWindow();
        if (params.standard == NftStandard.ERC721) {
            if (params.amount != 1) revert InvalidAmount();
        } else if (params.amount == 0) {
            revert InvalidAmount();
        }
        if (params.allowlistBonusEntries != 0 && params.allowlistRoot == bytes32(0)) {
            revert AllowlistBonusUnavailable();
        }
        if (_escrowedBy[params.nft][params.tokenId] != 0) {
            revert TokenAlreadyEscrowed(params.nft, params.tokenId);
        }
    }

    function _authorizeListing(
        CreateRaffleParams calldata params,
        uint64 signatureDeadline,
        bytes calldata sellerSignature
    ) private {
        if (!hasRole(CURATOR_ROLE, msg.sender)) {
            if (!_config.permissionlessListing || msg.sender != params.seller) revert ListingNotPermitted();
        } else if (msg.sender != params.seller && _config.sellerSignatureRequired) {
            _verifySellerListing(params, signatureDeadline, sellerSignature);
        }
    }

    function _emitCreated(uint256 raffleId, CreateRaffleParams calldata params, uint64 opensAt) private {
        emit RaffleCreated(
            raffleId,
            params.seller,
            params.nft,
            params.tokenId,
            params.amount,
            params.standard,
            opensAt,
            params.endsAt,
            params.reserveCommitment,
            params.metadataUri
        );
    }

    function updateMetadataUri(uint256 raffleId, string calldata uri) external onlyRole(CURATOR_ROLE) {
        _requireRaffle(raffleId);
        metadataUri[raffleId] = uri;
        emit RaffleMetadataUpdated(raffleId, uri);
    }

    /// @notice Cancels a raffle that never sold an entry and returns the NFT to the seller.
    function cancelBeforeEntries(uint256 raffleId) external onlyRole(CURATOR_ROLE) nonReentrant {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Open);
        if (raffle.totalEntries != 0) revert NoEntries();

        raffle.status = RaffleStatus.Cancelled;
        _releaseEscrow(raffle);
        _sendNft(raffle.nft, raffle.tokenId, raffle.amount, raffle.standard, raffle.seller);
        emit RaffleCancelled(raffleId);
    }

    // --------------------------------------------------------------------------------------------
    // Entering
    // --------------------------------------------------------------------------------------------

    /// @notice Spends entries already held in the caller's platform-wide balance on this raffle.
    function enterWithEntries(uint256 raffleId, uint32 count) external whenNotPaused nonReentrant {
        _spendAndEnter(raffleId, msg.sender, count, LabxEntryKind.LedgerBalance);
    }

    /// @notice One-click: buys a membership pack with USDC and puts its bonus entries into this raffle.
    /// @param allocateEntries Entries to spend here; 0 allocates every entry the pack granted.
    function buyPackWithUsdc(uint256 raffleId, uint8 tierId, uint32 allocateEntries)
        external
        whenNotPaused
        nonReentrant
    {
        uint32 granted = membership.purchaseForWithUsdc(msg.sender, tierId);
        uint32 toAllocate = allocateEntries == 0 ? granted : allocateEntries;
        _spendAndEnter(raffleId, msg.sender, toAllocate, LabxEntryKind.MembershipPack);
    }

    /// @notice One-click: buys a membership pack with ETH (swapped to USDC atomically) and enters.
    function buyPackWithEth(uint256 raffleId, uint8 tierId, uint32 allocateEntries, uint256 maxEthIn)
        external
        payable
        whenNotPaused
        nonReentrant
    {
        uint32 granted = membership.purchaseForWithEth{value: msg.value}(msg.sender, tierId, maxEthIn);
        uint32 toAllocate = allocateEntries == 0 ? granted : allocateEntries;
        _spendAndEnter(raffleId, msg.sender, toAllocate, LabxEntryKind.MembershipPack);
    }

    /// @notice Adds zero-value entries on behalf of the AMOE gateway (free entry, allowlist bonus).
    /// @dev Restricted to `ENTRY_ISSUER_ROLE`, which is granted to `LabxAmoeGateway` only. The gateway
    ///      owns the bot gate and the one-per-person bookkeeping; this contract owns the raffle rules.
    function creditFreeEntries(uint256 raffleId, address account, uint32 count, LabxEntryKind kind)
        external
        onlyRole(ENTRY_ISSUER_ROLE)
        whenNotPaused
        nonReentrant
    {
        if (count == 0) revert ZeroEntries();
        Raffle storage raffle = _requireEnterable(raffleId, account);
        _addEntries(raffleId, raffle, account, count, 0, count, 0, kind);
    }

    function _spendAndEnter(uint256 raffleId, address account, uint32 count, LabxEntryKind kind) private {
        if (count == 0) revert ZeroEntries();
        Raffle storage raffle = _requireEnterable(raffleId, account);

        (uint256 value, uint32 freeCount, uint64 earliestExpiry) = membership.spendEntries(account, count);
        raffle.pot += value;
        _addEntries(raffleId, raffle, account, count, value, freeCount, earliestExpiry, kind);
    }

    function _addEntries(
        uint256 raffleId,
        Raffle storage raffle,
        address account,
        uint32 count,
        uint256 value,
        uint32 freeCount,
        uint64 earliestExpiry,
        LabxEntryKind kind
    ) private {
        EntrantRecord storage record = entrants[raffleId][account];

        uint32 limit = raffle.maxEntriesPerUser;
        uint32 held = record.paidEntries + record.freeEntries;
        if (limit != 0 && held + count > limit) revert PerUserLimit(limit);

        Segment[] storage raffleSegments = segments[raffleId];
        uint32 segmentLimit = _config.maxSegmentsPerRaffle;
        if (raffleSegments.length + 1 > segmentLimit) revert SegmentLimit(segmentLimit);

        uint32 cumulative = raffle.totalEntries + count;
        raffle.totalEntries = cumulative;
        raffleSegments.push(Segment({account: account, cumulative: cumulative}));

        record.paidEntries += count - freeCount;
        record.freeEntries += freeCount;
        record.value += uint128(value);
        // `earliestExpiry` is 0 for entries that never came from the ledger (AMOE / allowlist); on a
        // refund those are re-issued with a fresh 12-month life instead of inheriting an expiry.
        if (earliestExpiry != 0 && (record.earliestExpiry == 0 || earliestExpiry < record.earliestExpiry)) {
            record.earliestExpiry = earliestExpiry;
        }

        bytes32 commitment =
            keccak256(abi.encode(raffle.entryCommitment, account, count, value, uint8(kind), cumulative));
        raffle.entryCommitment = commitment;

        emit EntriesAdded(raffleId, account, kind, count, value, cumulative, commitment);
    }

    // --------------------------------------------------------------------------------------------
    // Close, reveal, draw
    // --------------------------------------------------------------------------------------------

    /// @notice Freezes the entry list after `endsAt`. Permissionless.
    /// @dev The running `entryCommitment` hash chain covers every entry in order and is emitted here,
    ///      so the full entrant list is committed on-chain before any VRF request is made.
    function closeEntries(uint256 raffleId) external {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Open);
        if (block.timestamp < raffle.endsAt) revert EntriesStillOpen(raffle.endsAt);

        raffle.status = RaffleStatus.Closed;
        raffle.closedAt = uint64(block.timestamp);
        emit EntriesCommitted(raffleId, raffle.totalEntries, segments[raffleId].length, raffle.entryCommitment);
    }

    /// @notice Reveals the seller's reserve and starts the VRF draw, proving the reserve was met.
    /// @dev `reserveCommitment` was fixed at creation, so this can only succeed with the exact reserve and
    ///      salt the seller committed to. Use a high-entropy 32-byte salt: a predictable salt would let
    ///      anyone brute-force the commitment and learn the reserve early.
    function revealAndDraw(uint256 raffleId, uint256 reserveUsdc, bytes32 salt)
        external
        onlyRole(OPERATIONS_ROLE)
        returns (uint256 requestId)
    {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Closed);
        if (raffle.reserveRevealed) revert ReserveAlreadyRevealed();

        _verifyReserve(raffle, reserveUsdc, salt);
        if (raffle.pot < reserveUsdc) revert ReserveNotMet(raffle.pot, reserveUsdc);
        if (raffle.totalEntries == 0) revert NoEntries();

        raffle.reserveRevealed = true;
        raffle.reserveUsdc = reserveUsdc;
        emit ReserveRevealed(raffleId, reserveUsdc, raffle.pot, true);

        requestId = _startDraw(raffleId, raffle);
    }

    /// @notice Reveals the seller's reserve and starts refunds, proving the reserve was NOT met.
    function revealAndRefund(uint256 raffleId, uint256 reserveUsdc, bytes32 salt)
        external
        onlyRole(OPERATIONS_ROLE)
        nonReentrant
    {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Closed);
        if (raffle.reserveRevealed) revert ReserveAlreadyRevealed();

        _verifyReserve(raffle, reserveUsdc, salt);
        if (raffle.pot >= reserveUsdc && raffle.totalEntries != 0) revert ReserveMet(raffle.pot, reserveUsdc);

        raffle.reserveRevealed = true;
        raffle.reserveUsdc = reserveUsdc;
        emit ReserveRevealed(raffleId, reserveUsdc, raffle.pot, false);

        _startRefund(raffleId, raffle, "reserve-not-met");
    }

    /// @notice Requests another VRF draw after a redraw reset. The reserve is already revealed.
    function requestRedraw(uint256 raffleId) external onlyRole(OPERATIONS_ROLE) returns (uint256 requestId) {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Closed);
        if (!raffle.reserveRevealed) revert ReserveNotRevealed();
        requestId = _startDraw(raffleId, raffle);
    }

    /// @notice Buyer protection: if the operator does not reveal (or does not keep a draw moving) within
    ///         `operatorActionWindow`, anyone can force the refund path.
    function forceRefundAfterTimeout(uint256 raffleId) external nonReentrant {
        Raffle storage raffle = _requireRaffle(raffleId);
        RaffleStatus status = raffle.status;

        uint64 availableAt = 0;
        if (status == RaffleStatus.Closed) {
            availableAt = raffle.closedAt + _config.operatorActionWindow;
        } else if (status == RaffleStatus.Won) {
            availableAt = raffle.claimDeadline + _config.operatorActionWindow;
        } else if (status == RaffleStatus.Drawing) {
            // VRF never came back (subscription unfunded, coordinator issue): do not trap the entries.
            availableAt = raffle.drawRequestedAt + _config.operatorActionWindow;
        } else {
            revert WrongStatus(status, RaffleStatus.Closed);
        }

        if (block.timestamp <= availableAt) revert TimeoutNotReached(availableAt);
        _startRefund(raffleId, raffle, "operator-timeout");
    }

    function _verifyReserve(Raffle storage raffle, uint256 reserveUsdc, bytes32 salt) private view {
        if (keccak256(abi.encode(reserveUsdc, salt)) != raffle.reserveCommitment) revert BadReserveReveal();
    }

    function _startDraw(uint256 raffleId, Raffle storage raffle) private returns (uint256 requestId) {
        if (raffle.drawAttempts >= _config.maxDrawAttempts) revert DrawAttemptsExhausted();

        uint8 attempt = raffle.drawAttempts + 1;
        raffle.drawAttempts = attempt;
        raffle.status = RaffleStatus.Drawing;
        raffle.drawRequestedAt = uint64(block.timestamp);

        requestId = _requestRandomWords(1);
        raffle.vrfRequestId = requestId;
        _requestToRaffle[requestId] = raffleId + 1;

        emit DrawRequested(raffleId, requestId, attempt);
    }

    /// @dev VRF callback. Must never revert, or the randomness is stranded; an inconclusive draw simply
    ///      returns the raffle to `Closed` so the operator can request another word.
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        uint256 stored = _requestToRaffle[requestId];
        if (stored == 0) return;
        uint256 raffleId = stored - 1;

        Raffle storage raffle = _raffles[raffleId];
        if (raffle.status != RaffleStatus.Drawing || raffle.vrfRequestId != requestId) return;

        address winner = _pickWinner(raffleId, raffle.totalEntries, randomWords[0]);
        if (winner == address(0)) {
            raffle.status = RaffleStatus.Closed;
            emit DrawInconclusive(raffleId, requestId);
            return;
        }

        uint64 deadline = uint64(block.timestamp) + _config.claimWindow;
        raffle.winner = winner;
        raffle.prizeAccepted = false;
        raffle.claimDeadline = deadline;
        raffle.status = RaffleStatus.Won;
        emit WinnerSelected(raffleId, winner, requestId, deadline);
    }

    /// @dev Rejection sampling: re-hash the VRF word until it lands on a non-excluded entrant. Excluded
    ///      entrants are previous winners who let their claim window lapse.
    function _pickWinner(uint256 raffleId, uint32 totalEntries, uint256 randomWord)
        private
        view
        returns (address winner)
    {
        if (totalEntries == 0) return address(0);
        Segment[] storage raffleSegments = segments[raffleId];

        for (uint256 attempt; attempt < MAX_PICK_ATTEMPTS; ++attempt) {
            uint256 ticket = uint256(keccak256(abi.encode(randomWord, attempt))) % totalEntries;
            address candidate = raffleSegments[_searchSegment(raffleSegments, uint32(ticket))].account;
            if (!excludedFromDraw[raffleId][candidate]) return candidate;
        }
        return address(0);
    }

    /// @dev Smallest index whose cumulative weight is strictly greater than `ticket`.
    function _searchSegment(Segment[] storage haystack, uint32 ticket) private view returns (uint256) {
        uint256 low = 0;
        uint256 high = haystack.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (haystack[mid].cumulative <= ticket) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    // --------------------------------------------------------------------------------------------
    // Claiming and settlement
    // --------------------------------------------------------------------------------------------

    /// @notice Winner accepts the prize. Cheap on purpose: LABx then delivers and pays the gas.
    function acceptPrize(uint256 raffleId) external whenNotPaused {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Won);
        if (msg.sender != raffle.winner) revert NotWinner(msg.sender);
        if (block.timestamp > raffle.claimDeadline) revert ClaimWindowOpen(raffle.claimDeadline);
        _requireEligible(msg.sender);

        raffle.prizeAccepted = true;
        emit PrizeAccepted(raffleId, msg.sender);
    }

    /// @notice LABx delivers the accepted prize to the winner and settles the seller. Platform pays gas.
    function deliverPrize(uint256 raffleId) external onlyRole(OPERATIONS_ROLE) nonReentrant {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Won);
        if (!raffle.prizeAccepted) revert PrizeNotAccepted();
        _deliver(raffleId, raffle);
    }

    /// @notice Winner self-serve path: accept and take delivery in a single transaction.
    function claimPrize(uint256 raffleId) external whenNotPaused nonReentrant {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Won);
        if (msg.sender != raffle.winner) revert NotWinner(msg.sender);
        if (block.timestamp > raffle.claimDeadline) revert ClaimWindowOpen(raffle.claimDeadline);
        _requireEligible(msg.sender);

        raffle.prizeAccepted = true;
        emit PrizeAccepted(raffleId, msg.sender);
        _deliver(raffleId, raffle);
    }

    function _deliver(uint256 raffleId, Raffle storage raffle) private {
        address winner = raffle.winner;
        raffle.status = RaffleStatus.Delivered;
        _releaseEscrow(raffle);
        _sendNft(raffle.nft, raffle.tokenId, raffle.amount, raffle.standard, winner);
        emit PrizeDelivered(raffleId, winner, msg.sender);
        _settle(raffleId, raffle);
    }

    function _settle(uint256 raffleId, Raffle storage raffle) private {
        if (raffle.settled) return;
        raffle.settled = true;

        uint256 pot = raffle.pot;
        // `pot` tracks the USDC still escrowed for this raffle, so it is cleared as the funds leave.
        // The gross amount raised stays recoverable from `RaffleSettled` (proceeds + fee).
        raffle.pot = 0;
        if (pot == 0) {
            emit RaffleSettled(raffleId, raffle.seller, 0, 0);
            return;
        }

        uint256 fee = (pot * _config.platformFeeBps) / BPS_DENOMINATOR;
        uint256 proceeds = pot - fee;
        if (fee != 0) usdc.safeTransfer(treasury, fee);
        if (proceeds != 0) usdc.safeTransfer(raffle.seller, proceeds);

        emit RaffleSettled(raffleId, raffle.seller, proceeds, fee);
    }

    /// @notice Drops a non-responsive winner and re-opens the raffle for another VRF draw.
    function redraw(uint256 raffleId) external onlyRole(OPERATIONS_ROLE) nonReentrant {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Won);
        if (block.timestamp <= raffle.claimDeadline) revert ClaimWindowOpen(raffle.claimDeadline);
        if (raffle.prizeAccepted) revert PrizeAlreadyAccepted();

        address stale = raffle.winner;
        excludedFromDraw[raffleId][stale] = true;
        raffle.winner = address(0);
        emit WinnerExcluded(raffleId, stale, raffle.drawAttempts);

        if (raffle.drawAttempts >= _config.maxDrawAttempts) {
            _startRefund(raffleId, raffle, "draw-attempts-exhausted");
            return;
        }
        raffle.status = RaffleStatus.Closed;
        raffle.closedAt = uint64(block.timestamp);
    }

    // --------------------------------------------------------------------------------------------
    // Refunds
    // --------------------------------------------------------------------------------------------

    function _startRefund(uint256 raffleId, Raffle storage raffle, bytes32 reason) private {
        raffle.status = RaffleStatus.Refunding;
        _releaseEscrow(raffle);
        _sendNft(raffle.nft, raffle.tokenId, raffle.amount, raffle.standard, raffle.seller);
        emit RefundStarted(raffleId, reason);
    }

    /// @notice Returns one entrant's entries to their platform balance. Permissionless and idempotent, so
    ///         LABx can batch it for everyone or an entrant can pull their own.
    /// @dev Restored entries keep the earliest expiry of the batches originally spent, so a refund can
    ///      never extend an entry's 12-month life.
    function refundEntrant(uint256 raffleId, address account) public nonReentrant {
        Raffle storage raffle = _requireRaffleInStatus(raffleId, RaffleStatus.Refunding);

        EntrantRecord storage record = entrants[raffleId][account];
        if (record.refunded) revert AlreadyRefunded();
        uint32 paid = record.paidEntries;
        uint32 free = record.freeEntries;
        if (paid == 0 && free == 0) revert NothingToRefund();

        uint256 value = record.value;
        uint64 expiresAt = record.earliestExpiry;
        record.refunded = true;
        raffle.pot -= value;

        if (value != 0) usdc.forceApprove(address(membership), value);
        // slither-disable-next-line calls-loop  (reached from the `refundEntrants` batch helper by design)
        membership.refundEntries(account, paid, free, value, expiresAt);
        if (value != 0) usdc.forceApprove(address(membership), 0);

        emit EntrantRefunded(raffleId, account, paid, free, value);
    }

    /// @dev The loop makes one external call per entrant on purpose: refunds are independent, and a
    ///      single failure should not block the rest of the batch from being retried individually.
    // slither-disable-next-line calls-loop
    function refundEntrants(uint256 raffleId, address[] calldata accounts) external {
        for (uint256 i; i < accounts.length; ++i) {
            refundEntrant(raffleId, accounts[i]);
        }
    }

    // --------------------------------------------------------------------------------------------
    // NFT escrow helpers
    // --------------------------------------------------------------------------------------------

    function _pullNft(address nft, address from, uint256 tokenId, uint96 amount, NftStandard standard) private {
        if (standard == NftStandard.ERC721) {
            IERC721(nft).safeTransferFrom(from, address(this), tokenId);
        } else {
            IERC1155(nft).safeTransferFrom(from, address(this), tokenId, amount, "");
        }
    }

    function _sendNft(address nft, uint256 tokenId, uint96 amount, NftStandard standard, address to) private {
        if (standard == NftStandard.ERC721) {
            IERC721(nft).safeTransferFrom(address(this), to, tokenId);
        } else {
            IERC1155(nft).safeTransferFrom(address(this), to, tokenId, amount, "");
        }
    }

    function _releaseEscrow(Raffle storage raffle) private {
        _escrowedBy[raffle.nft][raffle.tokenId] = 0;
    }

    // --------------------------------------------------------------------------------------------
    // Views
    // --------------------------------------------------------------------------------------------

    /// @inheritdoc ILabxRaffleEntries
    function raffleEntryRules(uint256 raffleId)
        external
        view
        returns (bool acceptingEntries, bool freeEntryEnabled, bytes32 allowlistRoot, uint32 allowlistBonusEntries)
    {
        Raffle storage raffle = _requireRaffle(raffleId);
        acceptingEntries = raffle.status == RaffleStatus.Open && block.timestamp >= raffle.opensAt
            && block.timestamp < raffle.endsAt;
        return (acceptingEntries, raffle.freeEntryEnabled, raffle.allowlistRoot, raffle.allowlistBonusEntries);
    }

    function config() external view returns (Config memory) {
        return _config;
    }

    function raffleCount() external view returns (uint256) {
        return _raffles.length;
    }

    function raffles(uint256 raffleId) external view returns (Raffle memory) {
        if (raffleId >= _raffles.length) revert UnknownRaffle(raffleId);
        return _raffles[raffleId];
    }

    function segmentCount(uint256 raffleId) external view returns (uint256) {
        return segments[raffleId].length;
    }

    /// @notice Recomputes the reserve commitment so a seller can confirm the stored value off-chain.
    function reserveCommitmentFor(uint256 reserveUsdc, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(reserveUsdc, salt));
    }

    /// @notice When `forceRefundAfterTimeout` becomes callable; 0 when it is not applicable.
    function refundTimeoutAt(uint256 raffleId) external view returns (uint64) {
        Raffle storage raffle = _requireRaffle(raffleId);
        if (raffle.status == RaffleStatus.Closed) return raffle.closedAt + _config.operatorActionWindow;
        if (raffle.status == RaffleStatus.Won) return raffle.claimDeadline + _config.operatorActionWindow;
        if (raffle.status == RaffleStatus.Drawing) return raffle.drawRequestedAt + _config.operatorActionWindow;
        return 0;
    }

    function escrowedByRaffle(address nft, uint256 tokenId) external view returns (bool escrowed, uint256 raffleId) {
        uint256 stored = _escrowedBy[nft][tokenId];
        return (stored != 0, stored == 0 ? 0 : stored - 1);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // --------------------------------------------------------------------------------------------
    // Internal guards
    // --------------------------------------------------------------------------------------------

    function _requireRaffle(uint256 raffleId) private view returns (Raffle storage raffle) {
        if (raffleId >= _raffles.length) revert UnknownRaffle(raffleId);
        raffle = _raffles[raffleId];
    }

    function _requireStatus(Raffle storage raffle, RaffleStatus expected) private view {
        if (raffle.status != expected) revert WrongStatus(raffle.status, expected);
    }

    function _requireRaffleInStatus(uint256 raffleId, RaffleStatus expected)
        private
        view
        returns (Raffle storage raffle)
    {
        raffle = _requireRaffle(raffleId);
        _requireStatus(raffle, expected);
    }

    function _requireEnterable(uint256 raffleId, address account) private view returns (Raffle storage raffle) {
        raffle = _requireRaffle(raffleId);
        _requireStatus(raffle, RaffleStatus.Open);
        if (block.timestamp < raffle.opensAt) revert NotOpenYet(raffle.opensAt);
        if (block.timestamp >= raffle.endsAt) revert EntriesClosed(raffle.endsAt);
        _requireEligible(account);
    }

    function _requireEligible(address account) private view {
        if (address(terms) != address(0)) terms.requireAccepted(account);
        if (address(jurisdiction) != address(0)) jurisdiction.requireAllowed(account);
    }

    function _verifySellerListing(
        CreateRaffleParams calldata params,
        uint64 signatureDeadline,
        bytes calldata signature
    ) private {
        if (block.timestamp > signatureDeadline) revert AttestationExpired();

        uint256 nonce = listingNonce[params.seller];
        bytes32 structHash = keccak256(
            abi.encode(
                LIST_RAFFLE_TYPEHASH,
                params.seller,
                params.nft,
                params.tokenId,
                params.amount,
                uint8(params.standard),
                params.opensAt,
                params.endsAt,
                params.reserveCommitment,
                nonce,
                signatureDeadline
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        if (signer != params.seller) revert InvalidSellerSignature();
        listingNonce[params.seller] = nonce + 1;
    }

    /// @dev Resolves the `AccessControl` / `ERC1155Holder` ancestry for `supportsInterface`.
    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, ERC1155Holder) returns (bool) {
        return AccessControl.supportsInterface(interfaceId) || ERC1155Holder.supportsInterface(interfaceId);
    }
}
