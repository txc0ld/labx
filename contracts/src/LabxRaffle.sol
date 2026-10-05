// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {VRFV2PlusClient} from "./vendor/VRFV2PlusClient.sol";
import {IVRFCoordinatorV2Plus, ISwapRouter02, IWETH9, AggregatorV3Interface} from "./interfaces/External.sol";

/// @title LabxRaffle
/// @notice Sepolia membership-pack draws for LABx. Bonus entries are not tickets.
///         Ethereum mainnet (chain id 1) cannot be deployed. Treasury and admin are a Safe.
/// @dev Prize NFTs are escrowed and pulled after settlement or cancellation. USDC principal
///      and the lab fee are pulled separately, so a reverting receiver cannot freeze them.
///      A server-side commitment is stored as a hash and never decoded on-chain.
///      Randomness is Chainlink VRF v2.5, requested only after an entry snapshot. The
///      coordinator that accepted a request stays pinned until that draw ends.
///      `nativePayment` defaults to false (LINK). The live Sepolia deploy
///      `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` hardcodes that mode; fund the VRF
///      subscription with LINK until a redeploy that can set `nativePayment` true.
contract LabxRaffle is ReentrancyGuard, EIP712, IERC721Receiver {
    using SafeERC20 for IERC20;

    uint256 public constant LAB_FEE = 5_000_000; // 5 USDC, 6 decimals. Charged on top of the pack price.
    uint256 public constant ENTRY_EXPIRY = 365 days;
    uint32 public constant MAX_QTY = 20;
    uint8 public constant MAX_PACKS = 8;
    uint32 public constant MAX_BONUS_ENTRIES = 10_000;
    uint256 public constant MAX_PACK_PRICE = 1_000_000e6;
    uint256 public constant MAX_SLIPPAGE_BPS = 1_000;
    uint256 public constant SALES_WINDOW_CAP = 180 days;
    uint256 public constant PRICE_STALE_AFTER = 3 hours;
    uint256 public constant REVEAL_GRACE = 7 days;
    uint256 public constant VRF_ABORT_AFTER = 1 days;
    uint256 public constant MAX_ETH_DEADLINE = 10 minutes;
    uint256 public constant COORDINATOR_DELAY = 1 days;
    uint32 public constant DEFAULT_AMOE_CAP = 100;
    uint32 public constant MAX_AMOE_CAP = 10_000;
    uint16 public constant MIN_CONFIRMATIONS = 3;
    uint16 public constant MAX_CONFIRMATIONS = 200;

    bytes32 public constant AMOE_TYPEHASH =
        keccak256("AmoeClaim(uint256 raffleId,address account,bytes32 captchaDigest,uint256 deadline,bytes32 termsHash)");

    enum Phase {
        Draft,
        Open,
        Closed,
        Drawing,
        Drawn,
        Settled,
        Cancelled
    }

    struct PackConfig {
        string name;
        uint128 priceUsdc;
        uint32 bonusEntries;
        uint32 maxSupply;
    }

    struct Pack {
        string name;
        uint128 priceUsdc;
        uint32 bonusEntries;
        uint32 maxSupply;
        uint32 sold;
        bool active;
    }

    struct Lot {
        address owner;
        uint32 amount;
        uint64 expiresAt;
    }

    struct Raffle {
        address seller;
        address nft;
        uint256 tokenId;
        uint64 salesEnd;
        uint64 createdAt;
        uint64 drawnAt;
        uint64 vrfRequestedAt;
        Phase phase;
        bool escrowed;
        bool snapshotted;
        bool revealed;
        bytes32 reserveNonce;
        bytes32 reserveCommit;
        bytes32 publicHash;
        uint256 lotCursor;
        uint256 snapshotTotal;
        uint256 principalEscrow;
        uint256 feeEscrow;
        uint256 vrfRequestId;
        uint256 randomWord;
        address winner;
        uint8 packCount;
        uint32 amoeCount;
        string title;
    }

    struct RaffleView {
        address seller;
        address nft;
        uint256 tokenId;
        uint64 salesEnd;
        uint64 createdAt;
        uint64 drawnAt;
        uint64 vrfRequestedAt;
        Phase phase;
        bool escrowed;
        bool snapshotted;
        bool revealed;
        bytes32 reserveNonce;
        bytes32 reserveCommit;
        bytes32 publicHash;
        uint256 lotCursor;
        uint256 snapshotTotal;
        uint256 principalEscrow;
        uint256 feeEscrow;
        uint256 vrfRequestId;
        uint256 randomWord;
        address winner;
        uint8 packCount;
        uint32 amoeCount;
        string title;
    }

    struct Init {
        address treasury;
        address usdc;
        address router;
        address weth;
        address ethUsdFeed;
        uint24 poolFee;
        address vrfCoordinator;
        bytes32 keyHash;
        uint256 subscriptionId;
        address amoeSigner;
        bytes32 termsHash;
        uint32 callbackGasLimit;
        uint16 requestConfirmations;
        uint32 amoeCap;
    }

    error MainnetDisabled();
    error ZeroAddress();
    error NotOwner();
    error NotPendingOwner();
    error NotSeller();
    error BadPhase();
    error BadPack();
    error BadQty();
    error SoldOut();
    error TermsMismatch();
    error TermsUnset();
    error Paused();
    error SalesClosed();
    error SalesStarted();
    error EscrowMissing();
    error EscrowFailed();
    error EmptyDraw();
    error RevealMismatch();
    error RevealRequired();
    error TooEarly();
    error OnlyCoordinator(address have, address want);
    error EthPathDisabled();
    error StalePrice();
    error BadFeed();
    error InsufficientEth();
    error SlippageTooHigh();
    error SwapShortfall();
    error RefundFailed();
    error DirectEthDisabled();
    error BadWindow();
    error BadConfig();
    error UsdcDecimals();
    error AmoeUsed();
    error AmoeCap();
    error CaptchaUsed();
    error BadSignature();
    error Expired();
    error NotWinner();
    error NotClaimable();
    error BadDeadline();
    error DrawInFlight();

    IERC20 public immutable usdc;

    address public owner;
    address public pendingOwner;
    address public treasury;
    address public amoeSigner;
    address public vrfCoordinator;
    address public pendingCoordinator;
    uint256 public coordinatorEta;
    uint256 public activeDrawings;
    address public immutable router;
    address public immutable weth;
    address public immutable ethUsdFeed;
    bytes32 public keyHash;
    bytes32 public termsHash;
    uint256 public subscriptionId;
    uint32 public callbackGasLimit;
    uint16 public requestConfirmations;
    uint24 public immutable poolFee;
    uint32 public amoeCap;
    bool public ethPathEnabled;
    /// @notice VRF v2.5 extraArgs payment mode. False = LINK (default, matches Sepolia
    ///         `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C`). True = native ETH. Owner-settable
    ///         only while `activeDrawings == 0`. Live Sepolia must keep LINK funding until a
    ///         redeploy can flip this.
    bool public nativePayment;
    bool public paused;
    uint256 public nextId = 1;
    bool private _awaitingRequest;
    uint256 private _syncRequestId;
    uint256 private _syncWord;
    bool private _syncFilled;

    mapping(uint256 => Raffle) internal _raffles;
    mapping(uint256 => mapping(uint8 => Pack)) internal _packs;
    mapping(uint256 => Lot[]) internal _lots;
    mapping(uint256 => uint256[]) public cumulatives;
    mapping(uint256 => address[]) public snapshotOwners;
    mapping(uint256 => mapping(address => uint256)) public principalOf;
    mapping(uint256 => mapping(address => uint256)) public feeOf;
    mapping(uint256 => mapping(address => bool)) public amoeClaimed;
    mapping(bytes32 => bool) public captchaUsed;
    mapping(uint256 => uint256) public requestToRaffle;
    mapping(uint256 => address) public requestCoordinator;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RaffleCreated(uint256 indexed id, address indexed seller, address indexed nft, uint256 tokenId, bytes32 reserveCommit);
    event Escrowed(uint256 indexed id, address indexed nft, uint256 tokenId);
    event Opened(uint256 indexed id);
    event Closed(uint256 indexed id);
    event PackPurchased(
        uint256 indexed id,
        address indexed buyer,
        uint8 packId,
        uint32 qty,
        uint32 bonusEntries,
        uint256 principal,
        uint256 fee,
        bool paidWithEth
    );
    event SnapshotProgress(uint256 indexed id, uint256 cursor, uint256 snapshotTotal);
    event RandomnessRequested(uint256 indexed id, uint256 indexed requestId);
    event WinnerDrawn(uint256 indexed id, address indexed winner, uint256 randomWord);
    event Revealed(uint256 indexed id, bytes32 publicHash, bytes32 privateHash);
    event Settled(uint256 indexed id, address indexed winner, uint256 principal, uint256 fee);
    event Cancelled(uint256 indexed id);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event AmoeClaimed(uint256 indexed id, address indexed account);
    event TermsUpdated(bytes32 termsHash);
    event PausedSet(bool paused);
    event PrizeClaimed(uint256 indexed id, address indexed winner);
    event PrizeReclaimed(uint256 indexed id, address indexed seller);
    event ProceedsClaimed(uint256 indexed id, address indexed seller, uint256 principal);
    event FeeClaimed(uint256 indexed id, address indexed treasury, uint256 fee);
    event CoordinatorProposed(address indexed next, uint256 eta);
    event CoordinatorApplied(address indexed coordinator);
    event EthPathSet(bool enabled);
    event TreasurySet(address indexed previous, address indexed next);
    event AmoeSignerSet(address indexed previous, address indexed next);
    event VrfConfigSet(bytes32 keyHash, uint256 subscriptionId, uint32 callbackGasLimit, uint16 requestConfirmations);
    event NativePaymentSet(bool nativePayment);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(Init memory init) EIP712("LABx", "1") {
        if (block.chainid == 1) revert MainnetDisabled();
        if (
            init.treasury == address(0) || init.usdc == address(0) || init.vrfCoordinator == address(0)
                || init.amoeSigner == address(0)
        ) revert ZeroAddress();
        if (init.termsHash == bytes32(0) || init.keyHash == bytes32(0) || init.subscriptionId == 0) revert BadConfig();
        if (init.callbackGasLimit < 200_000 || init.callbackGasLimit > 2_500_000) revert BadConfig();
        if (init.requestConfirmations < MIN_CONFIRMATIONS || init.requestConfirmations > MAX_CONFIRMATIONS) {
            revert BadConfig();
        }
        if (IERC20Metadata(init.usdc).decimals() != 6) revert UsdcDecimals();
        bool ethConfigured = init.router != address(0) || init.weth != address(0) || init.ethUsdFeed != address(0);
        if (ethConfigured) {
            if (init.router == address(0) || init.weth == address(0) || init.ethUsdFeed == address(0)) revert BadConfig();
            if (AggregatorV3Interface(init.ethUsdFeed).decimals() != 8) revert BadFeed();
        }
        uint32 cap = init.amoeCap == 0 ? DEFAULT_AMOE_CAP : init.amoeCap;
        if (cap > MAX_AMOE_CAP) revert BadConfig();

        owner = msg.sender;
        treasury = init.treasury;
        usdc = IERC20(init.usdc);
        router = init.router;
        weth = init.weth;
        ethUsdFeed = init.ethUsdFeed;
        poolFee = init.poolFee == 0 ? 3000 : init.poolFee;
        ethPathEnabled = ethConfigured;
        amoeCap = cap;
        vrfCoordinator = init.vrfCoordinator;
        keyHash = init.keyHash;
        subscriptionId = init.subscriptionId;
        amoeSigner = init.amoeSigner;
        termsHash = init.termsHash;
        callbackGasLimit = init.callbackGasLimit;
        requestConfirmations = init.requestConfirmations;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    receive() external payable {
        if (msg.sender != weth) revert DirectEthDisabled();
    }

    // --- admin (Safe) ---

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert ZeroAddress();
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit TreasurySet(treasury, next);
        treasury = next;
    }

    function setAmoeSigner(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit AmoeSignerSet(amoeSigner, next);
        amoeSigner = next;
    }

    function setTermsHash(bytes32 next) external onlyOwner {
        if (next == bytes32(0)) revert TermsUnset();
        termsHash = next;
        emit TermsUpdated(next);
    }

    function setVrfConfig(bytes32 nextKeyHash, uint256 nextSubId, uint32 gasLimit, uint16 confirmations)
        external
        onlyOwner
    {
        if (activeDrawings != 0) revert DrawInFlight();
        if (nextKeyHash == bytes32(0) || nextSubId == 0) revert BadConfig();
        if (gasLimit < 200_000 || gasLimit > 2_500_000) revert BadConfig();
        if (confirmations < MIN_CONFIRMATIONS || confirmations > MAX_CONFIRMATIONS) revert BadConfig();
        keyHash = nextKeyHash;
        subscriptionId = nextSubId;
        callbackGasLimit = gasLimit;
        requestConfirmations = confirmations;
        emit VrfConfigSet(nextKeyHash, nextSubId, gasLimit, confirmations);
    }

    /// @notice Flips VRF v2.5 LINK vs native ETH billing for the *next* request.
    ///         Refused while a draw is in flight so in-flight and retry requests cannot
    ///         mix payment modes. ExtraArgs are snapshotted at request time.
    function setNativePayment(bool next) external onlyOwner {
        if (activeDrawings != 0) revert DrawInFlight();
        nativePayment = next;
        emit NativePaymentSet(next);
    }

    /// @notice Starts a one-day delay before the VRF coordinator can change.
    ///         Refuses while a draw is in flight so the pinned coordinator cannot be swapped out.
    function proposeCoordinator(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        if (activeDrawings != 0) revert DrawInFlight();
        pendingCoordinator = next;
        coordinatorEta = block.timestamp + COORDINATOR_DELAY;
        emit CoordinatorProposed(next, coordinatorEta);
    }

    function applyCoordinator() external onlyOwner {
        if (activeDrawings != 0) revert DrawInFlight();
        address next = pendingCoordinator;
        if (next == address(0)) revert ZeroAddress();
        if (block.timestamp < coordinatorEta) revert TooEarly();
        vrfCoordinator = next;
        pendingCoordinator = address(0);
        coordinatorEta = 0;
        emit CoordinatorApplied(next);
    }

    /// @notice Turns the immutable ETH path on or off. Router, WETH, and the feed cannot be replaced.
    function setEthPathEnabled(bool next) external onlyOwner {
        if (next && (router == address(0) || weth == address(0) || ethUsdFeed == address(0))) revert EthPathDisabled();
        ethPathEnabled = next;
        emit EthPathSet(next);
    }

    // --- seller lifecycle ---

    function createRaffle(
        address nft,
        uint256 tokenId,
        uint64 salesEnd,
        bytes32 reserveNonce,
        bytes32 reserveCommit,
        string calldata title,
        PackConfig[] calldata configs
    ) external returns (uint256 id) {
        if (nft == address(0)) revert ZeroAddress();
        if (salesEnd <= block.timestamp || salesEnd > block.timestamp + SALES_WINDOW_CAP) revert BadWindow();
        if (reserveNonce == bytes32(0) || reserveCommit == bytes32(0)) revert BadConfig();
        if (bytes(title).length == 0 || bytes(title).length > 80) revert BadConfig();
        uint256 n = configs.length;
        if (n == 0 || n > MAX_PACKS) revert BadConfig();

        id = nextId++;
        Raffle storage r = _raffles[id];
        r.seller = msg.sender;
        r.nft = nft;
        r.tokenId = tokenId;
        r.salesEnd = salesEnd;
        r.createdAt = uint64(block.timestamp);
        r.reserveNonce = reserveNonce;
        r.reserveCommit = reserveCommit;
        r.title = title;
        r.packCount = uint8(n);
        r.phase = Phase.Draft;

        for (uint8 i = 0; i < n; ++i) {
            PackConfig calldata cfg = configs[i];
            if (bytes(cfg.name).length == 0 || bytes(cfg.name).length > 32) revert BadConfig();
            if (cfg.priceUsdc == 0 || cfg.priceUsdc > MAX_PACK_PRICE) revert BadConfig();
            if (cfg.bonusEntries == 0 || cfg.bonusEntries > MAX_BONUS_ENTRIES) revert BadConfig();
            if (cfg.maxSupply == 0) revert BadConfig();
            _packs[id][i] = Pack({
                name: cfg.name,
                priceUsdc: cfg.priceUsdc,
                bonusEntries: cfg.bonusEntries,
                maxSupply: cfg.maxSupply,
                sold: 0,
                active: true
            });
        }
        emit RaffleCreated(id, msg.sender, nft, tokenId, reserveCommit);
    }

    function escrow(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (msg.sender != r.seller) revert NotSeller();
        if (r.phase != Phase.Draft || r.escrowed) revert BadPhase();
        r.escrowed = true;
        IERC721(r.nft).safeTransferFrom(msg.sender, address(this), r.tokenId);
        if (IERC721(r.nft).ownerOf(r.tokenId) != address(this)) revert EscrowFailed();
        emit Escrowed(id, r.nft, r.tokenId);
    }

    function open(uint256 id) external nonReentrant {
        if (paused) revert Paused();
        Raffle storage r = _raffles[id];
        if (msg.sender != r.seller) revert NotSeller();
        if (r.phase != Phase.Draft) revert BadPhase();
        if (!r.escrowed) revert EscrowMissing();
        if (block.timestamp >= r.salesEnd) revert SalesClosed();
        r.phase = Phase.Open;
        emit Opened(id);
    }

    function close(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Open) revert BadPhase();
        if (msg.sender != r.seller && msg.sender != owner && block.timestamp < r.salesEnd) revert NotSeller();
        r.phase = Phase.Closed;
        emit Closed(id);
    }

    function buyPack(uint256 id, uint8 packId, uint32 qty, bytes32 acceptedTerms) external nonReentrant {
        (uint256 principal, uint256 fee) = _quote(id, packId, qty, acceptedTerms);
        usdc.safeTransferFrom(msg.sender, address(this), principal + fee);
        _credit(id, packId, qty, principal, fee, false);
    }

    function buyPackWithEth(
        uint256 id,
        uint8 packId,
        uint32 qty,
        bytes32 acceptedTerms,
        uint16 slippageBps,
        uint256 deadline
    ) external payable nonReentrant {
        if (!ethPathEnabled) revert EthPathDisabled();
        if (deadline == 0 || deadline < block.timestamp || deadline > block.timestamp + MAX_ETH_DEADLINE) {
            revert BadDeadline();
        }
        if (slippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        (uint256 principal, uint256 fee) = _quote(id, packId, qty, acceptedTerms);
        uint256 total = principal + fee;
        uint256 minEth = quoteEthForUsdc(total);
        uint256 cap = (minEth * (10_000 + slippageBps) + 9_999) / 10_000;
        if (msg.value < cap) revert InsufficientEth();
        uint256 spent = _swapEthForUsdc(total, cap, deadline);
        _credit(id, packId, qty, principal, fee, true);
        if (spent < msg.value) _refundEth(msg.value - spent);
    }

    /// @notice One complimentary bonus entry per account per draw. Signature is produced off-chain
    ///         after a captcha check. This path is not a pack purchase.
    function claimAmoe(uint256 id, bytes32 captchaDigest, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (paused) revert Paused();
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Open || block.timestamp >= r.salesEnd) revert SalesClosed();
        if (block.timestamp > deadline) revert Expired();
        if (captchaDigest == bytes32(0) || captchaUsed[captchaDigest]) revert CaptchaUsed();
        if (amoeClaimed[id][msg.sender]) revert AmoeUsed();
        if (r.amoeCount >= amoeCap) revert AmoeCap();
        bytes32 digest = hashAmoe(id, msg.sender, captchaDigest, deadline);
        (address signer, ECDSA.RecoverError err, bytes32 errArg) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || errArg != bytes32(0) || signer != amoeSigner) revert BadSignature();
        captchaUsed[captchaDigest] = true;
        amoeClaimed[id][msg.sender] = true;
        r.amoeCount += 1;
        _lots[id].push(Lot({owner: msg.sender, amount: 1, expiresAt: uint64(block.timestamp + ENTRY_EXPIRY)}));
        emit AmoeClaimed(id, msg.sender);
    }

    function snapshot(uint256 id, uint256 maxSteps) external nonReentrant {
        if (maxSteps == 0 || maxSteps > 500) revert BadConfig();
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Closed || r.snapshotted) revert BadPhase();
        uint256 end = r.lotCursor + maxSteps;
        uint256 len = _lots[id].length;
        if (end > len) end = len;
        uint256 cum = r.snapshotTotal;
        for (uint256 i = r.lotCursor; i < end; ++i) {
            Lot memory lot = _lots[id][i];
            if (lot.amount == 0 || lot.expiresAt <= block.timestamp) continue;
            cum += lot.amount;
            cumulatives[id].push(cum);
            snapshotOwners[id].push(lot.owner);
        }
        r.lotCursor = end;
        r.snapshotTotal = cum;
        if (end == len) r.snapshotted = true;
        emit SnapshotProgress(id, end, cum);
    }

    function requestRandomness(uint256 id) external nonReentrant {
        if (paused) revert Paused();
        Raffle storage r = _raffles[id];
        if (msg.sender != r.seller && msg.sender != owner) revert NotSeller();
        if (r.phase != Phase.Closed || !r.snapshotted) revert BadPhase();
        if (r.snapshotTotal == 0) revert EmptyDraw();
        (uint256 requestId, address pinned) = _requestWords();
        r.phase = Phase.Drawing;
        activeDrawings += 1;
        _pinRequest(id, requestId, pinned);
    }

    /// @notice Re-request VRF while the raffle is still Drawing and has no winner.
    ///         Use after a failed or dropped callback (Chainlink does not retry). Owner-only
    ///         so a seller cannot drain the VRF subscription. Key hash, sub id, gas limit,
    ///         and payment mode stay frozen until `activeDrawings` is 0 (same as M-2).
    ///         The previous `requestToRaffle` mapping is forgotten after the new request
    ///         succeeds; a late fulfill of the old id is ignored. Restarts `VRF_ABORT_AFTER`
    ///         from this call.
    function retryRandomness(uint256 id) external onlyOwner nonReentrant {
        if (paused) revert Paused();
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Drawing) revert BadPhase();
        uint256 oldId = r.vrfRequestId;
        (uint256 requestId, address pinned) = _requestWords();
        _forgetRequest(oldId);
        _pinRequest(id, requestId, pinned);
    }

    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        address pinned = requestCoordinator[requestId];
        if (pinned == address(0)) {
            if (_awaitingRequest && msg.sender == vrfCoordinator && randomWords.length != 0) {
                _syncRequestId = requestId;
                _syncWord = randomWords[0];
                _syncFilled = true;
            }
            return;
        }
        if (msg.sender != pinned) revert OnlyCoordinator(msg.sender, pinned);
        uint256 id = requestToRaffle[requestId];
        if (id == 0 || randomWords.length == 0) return;
        _applyWord(id, requestId, randomWords[0]);
    }

    /// @notice Proves the off-chain commitment. Plaintext stays off-chain; only hashes are submitted.
    function reveal(uint256 id, bytes32 publicHash, bytes32 privateHash, bytes32 salt) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (msg.sender != r.seller && msg.sender != owner) revert NotSeller();
        if (r.revealed) revert BadPhase();
        if (r.phase == Phase.Draft || r.phase == Phase.Settled || r.phase == Phase.Cancelled) revert BadPhase();
        bytes32 got = hashCommitment(r.reserveNonce, r.nft, r.tokenId, publicHash, privateHash, salt);
        if (got != r.reserveCommit) revert RevealMismatch();
        r.revealed = true;
        r.publicHash = publicHash;
        emit Revealed(id, publicHash, privateHash);
    }

    function settle(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Drawn) revert BadPhase();
        if (!r.revealed) {
            if (msg.sender != owner || block.timestamp < uint256(r.drawnAt) + REVEAL_GRACE) revert RevealRequired();
        }
        r.phase = Phase.Settled;
        emit Settled(id, r.winner, r.principalEscrow, r.feeEscrow);
    }

    /// @notice Winner pulls the NFT with `transferFrom`, so `onERC721Received` cannot revert the claim.
    function claimPrize(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Settled) revert BadPhase();
        if (msg.sender != r.winner) revert NotWinner();
        if (!r.escrowed) revert NotClaimable();
        r.escrowed = false;
        IERC721(r.nft).transferFrom(address(this), r.winner, r.tokenId);
        emit PrizeClaimed(id, r.winner);
    }

    function claimProceeds(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Settled) revert BadPhase();
        if (msg.sender != r.seller) revert NotSeller();
        uint256 principal = r.principalEscrow;
        if (principal == 0) revert NotClaimable();
        r.principalEscrow = 0;
        usdc.safeTransfer(r.seller, principal);
        emit ProceedsClaimed(id, r.seller, principal);
    }

    function claimFee(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Settled) revert BadPhase();
        uint256 fee = r.feeEscrow;
        if (fee == 0) revert NotClaimable();
        address payee = treasury;
        r.feeEscrow = 0;
        usdc.safeTransfer(payee, fee);
        emit FeeClaimed(id, payee, fee);
    }

    /// @notice Seller may cancel before funds arrive, or after an empty snapshot.
    ///         The owner may force-cancel a funded Open/Closed raffle. That is accepted
    ///         v1 centralization (Chain Security H-3): buyers refund, prize returns to the
    ///         seller. A pause+timelock on this path is a follow-up, not a silent removal.
    function cancel(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        Phase p = r.phase;
        bool admin = msg.sender == owner;
        if (msg.sender != r.seller && !admin) revert NotSeller();
        if (p == Phase.Drawing || p == Phase.Drawn || p == Phase.Settled || p == Phase.Cancelled) revert BadPhase();
        if (!admin) {
            if (p == Phase.Open && r.principalEscrow != 0) revert SalesStarted();
            if (p == Phase.Closed && !(r.snapshotted && r.snapshotTotal == 0)) revert BadPhase();
        }
        r.phase = Phase.Cancelled;
        emit Cancelled(id);
    }

    /// @notice Owner cancels a stuck Drawing after `VRF_ABORT_AFTER`. Clears `requestToRaffle`
    ///         so a late coordinator callback cannot land on this raffle.
    function abortDrawing(uint256 id) external onlyOwner nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Drawing) revert BadPhase();
        if (block.timestamp < uint256(r.vrfRequestedAt) + VRF_ABORT_AFTER) revert TooEarly();
        _forgetRequest(r.vrfRequestId);
        r.vrfRequestId = 0;
        r.phase = Phase.Cancelled;
        activeDrawings -= 1;
        emit Cancelled(id);
    }

    /// @notice Seller pulls the NFT after a cancel or an aborted draw.
    function reclaimPrize(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Cancelled) revert BadPhase();
        if (msg.sender != r.seller) revert NotSeller();
        if (!r.escrowed) revert NotClaimable();
        r.escrowed = false;
        IERC721(r.nft).transferFrom(address(this), r.seller, r.tokenId);
        emit PrizeReclaimed(id, r.seller);
    }

    function refund(uint256 id) external nonReentrant {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Cancelled) revert BadPhase();
        uint256 principal = principalOf[id][msg.sender];
        uint256 fee = feeOf[id][msg.sender];
        uint256 amount = principal + fee;
        if (amount == 0) revert BadPhase();
        principalOf[id][msg.sender] = 0;
        feeOf[id][msg.sender] = 0;
        r.principalEscrow -= principal;
        r.feeEscrow -= fee;
        usdc.safeTransfer(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // --- views ---

    function getRaffle(uint256 id) external view returns (RaffleView memory v) {
        Raffle storage r = _raffles[id];
        v.seller = r.seller;
        v.nft = r.nft;
        v.tokenId = r.tokenId;
        v.salesEnd = r.salesEnd;
        v.createdAt = r.createdAt;
        v.drawnAt = r.drawnAt;
        v.vrfRequestedAt = r.vrfRequestedAt;
        v.phase = r.phase;
        v.escrowed = r.escrowed;
        v.snapshotted = r.snapshotted;
        v.revealed = r.revealed;
        v.reserveNonce = r.reserveNonce;
        v.reserveCommit = r.reserveCommit;
        v.publicHash = r.publicHash;
        v.lotCursor = r.lotCursor;
        v.snapshotTotal = r.snapshotTotal;
        v.principalEscrow = r.principalEscrow;
        v.feeEscrow = r.feeEscrow;
        v.vrfRequestId = r.vrfRequestId;
        v.randomWord = r.randomWord;
        v.winner = r.winner;
        v.packCount = r.packCount;
        v.amoeCount = r.amoeCount;
        v.title = r.title;
    }

    function getPack(uint256 id, uint8 packId) external view returns (Pack memory) {
        return _packs[id][packId];
    }

    function lotCount(uint256 id) external view returns (uint256) {
        return _lots[id].length;
    }

    function lotAt(uint256 id, uint256 index) external view returns (Lot memory) {
        return _lots[id][index];
    }

    function hashAmoe(uint256 id, address account, bytes32 captchaDigest, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(AMOE_TYPEHASH, id, account, captchaDigest, deadline, termsHash))
        );
    }

    function hashCommitment(
        bytes32 nonce,
        address nft,
        uint256 tokenId,
        bytes32 publicHash,
        bytes32 privateHash,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), nonce, nft, tokenId, publicHash, privateHash, salt));
    }

    function quoteEthForUsdc(uint256 usdcAmount) public view returns (uint256 ethWei) {
        if (ethUsdFeed == address(0)) revert EthPathDisabled();
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound) =
            AggregatorV3Interface(ethUsdFeed).latestRoundData();
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || startedAt > block.timestamp) revert StalePrice();
        if (answeredInRound < roundId || block.timestamp - updatedAt > PRICE_STALE_AFTER) revert StalePrice();
        if (AggregatorV3Interface(ethUsdFeed).decimals() != 8) revert BadFeed();
        ethWei = (usdcAmount * 1e20 + uint256(answer) - 1) / uint256(answer);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // --- internals ---

    function _quote(uint256 id, uint8 packId, uint32 qty, bytes32 acceptedTerms)
        internal
        view
        returns (uint256 principal, uint256 fee)
    {
        if (paused) revert Paused();
        if (acceptedTerms != termsHash) revert TermsMismatch();
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Open || block.timestamp >= r.salesEnd) revert SalesClosed();
        if (qty == 0 || qty > MAX_QTY) revert BadQty();
        if (packId >= r.packCount) revert BadPack();
        Pack storage p = _packs[id][packId];
        if (!p.active) revert BadPack();
        if (uint256(p.sold) + qty > p.maxSupply) revert SoldOut();
        principal = uint256(p.priceUsdc) * qty;
        fee = LAB_FEE * qty;
    }

    function _credit(uint256 id, uint8 packId, uint32 qty, uint256 principal, uint256 fee, bool paidWithEth) internal {
        Pack storage p = _packs[id][packId];
        p.sold += qty;
        Raffle storage r = _raffles[id];
        r.principalEscrow += principal;
        r.feeEscrow += fee;
        principalOf[id][msg.sender] += principal;
        feeOf[id][msg.sender] += fee;
        uint32 entries = p.bonusEntries * qty;
        _lots[id].push(Lot({owner: msg.sender, amount: entries, expiresAt: uint64(block.timestamp + ENTRY_EXPIRY)}));
        emit PackPurchased(id, msg.sender, packId, qty, entries, principal, fee, paidWithEth);
    }

    function _select(uint256 id, uint256 word) internal view returns (address) {
        uint256 total = _raffles[id].snapshotTotal;
        uint256 target = word % total;
        uint256[] storage c = cumulatives[id];
        uint256 lo = 0;
        uint256 hi = c.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            if (c[mid] > target) hi = mid;
            else lo = mid + 1;
        }
        return snapshotOwners[id][lo];
    }

    function _swapEthForUsdc(uint256 usdcOut, uint256 cap, uint256 deadline) internal returns (uint256 spent) {
        uint256 wethBefore = IWETH9(weth).balanceOf(address(this));
        IWETH9(weth).deposit{value: msg.value}();
        if (!IWETH9(weth).approve(router, cap)) revert RefundFailed();
        uint256 usdcBefore = usdc.balanceOf(address(this));
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(
            ISwapRouter02.exactOutputSingle,
            (
                ISwapRouter02.ExactOutputSingleParams({
                    tokenIn: weth,
                    tokenOut: address(usdc),
                    fee: poolFee,
                    recipient: address(this),
                    amountOut: usdcOut,
                    amountInMaximum: cap,
                    sqrtPriceLimitX96: 0
                })
            )
        );
        ISwapRouter02(router).multicall(deadline, calls);
        if (usdc.balanceOf(address(this)) - usdcBefore < usdcOut) revert SwapShortfall();
        uint256 deposited = wethBefore + msg.value;
        uint256 wethAfter = IWETH9(weth).balanceOf(address(this));
        if (wethAfter > deposited) revert SwapShortfall();
        spent = deposited - wethAfter;
        if (spent > cap) revert SwapShortfall();
    }

    function _refundEth(uint256 refundEth) internal {
        IWETH9(weth).withdraw(refundEth);
        (bool ok,) = msg.sender.call{value: refundEth}("");
        if (!ok) revert RefundFailed();
    }

    function _requestWords() internal returns (uint256 requestId, address pinned) {
        pinned = vrfCoordinator;
        _awaitingRequest = true;
        _syncFilled = false;
        requestId = IVRFCoordinatorV2Plus(pinned).requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: keyHash,
                subId: subscriptionId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativePayment}))
            })
        );
        _awaitingRequest = false;
        if (requestId == 0) revert BadConfig();
    }

    function _pinRequest(uint256 id, uint256 requestId, address pinned) internal {
        Raffle storage r = _raffles[id];
        r.vrfRequestId = requestId;
        r.vrfRequestedAt = uint64(block.timestamp);
        requestToRaffle[requestId] = id;
        requestCoordinator[requestId] = pinned;
        emit RandomnessRequested(id, requestId);
        if (_syncFilled && _syncRequestId == requestId) _applyWord(id, requestId, _syncWord);
    }

    function _forgetRequest(uint256 requestId) internal {
        if (requestId == 0) return;
        delete requestToRaffle[requestId];
        delete requestCoordinator[requestId];
    }

    function _applyWord(uint256 id, uint256 requestId, uint256 word) internal {
        Raffle storage r = _raffles[id];
        if (r.phase != Phase.Drawing || r.vrfRequestId != requestId) return;
        activeDrawings -= 1;
        r.randomWord = word;
        r.winner = _select(id, word);
        r.drawnAt = uint64(block.timestamp);
        r.phase = Phase.Drawn;
        emit WinnerDrawn(id, r.winner, word);
    }
}
