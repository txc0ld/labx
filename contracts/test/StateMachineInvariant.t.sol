// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockVRF} from "./mocks/Mocks.sol";

/// @notice Drives LabxRaffle with random calls from two owners, two sellers, four buyers and an outsider across up to
///         six raffles and two coordinators. Every call is predicted from the documented guards first, and the handler
///         asserts that the contract accepted or rejected it as predicted. It never reverts itself, so the invariant
///         run uses fail-on-revert.
contract RaffleHandler is Test {
    uint256 internal constant MAX_RAFFLES = 6;
    uint256 internal constant WEEK = 7 days;
    bytes32 internal constant PUBLIC_HASH = keccak256("public");
    bytes32 internal constant PRIVATE_HASH = keccak256("private");
    bytes32 internal constant SALT = bytes32(uint256(9));

    struct Request {
        address coordinator;
        uint256 id;
    }

    LabxRaffle public labx;
    MockERC20 public usdc;
    MockERC721 public nft;
    MockVRF public vrfA;
    MockVRF public vrfB;

    address[2] internal owners;
    address[2] internal sellers;
    address[2] internal treasuries;
    address[4] public buyers;
    address internal outsider = makeAddr("outsider");

    uint256[] public ids;
    Request[] internal requests;
    uint256 internal nextToken = 1;

    // Ghost state the invariants compare with the contract.
    mapping(uint256 => uint256) public paidIn;
    mapping(uint256 => uint256) public paidOut;
    mapping(uint256 => uint256) public grossPrincipal;
    mapping(uint256 => uint256) public buyerFees;
    mapping(uint256 => uint256) public entries;
    mapping(uint256 => uint256) public refunded;
    mapping(uint256 => uint256) public proceedsPaid;
    mapping(uint256 => uint256) public feesPaid;
    mapping(uint256 => uint256) public proceedsClaims;
    mapping(uint256 => uint256) public prizeReleases;
    mapping(uint256 => mapping(address => uint256)) public refunds;
    mapping(uint256 => uint256) public draws;
    mapping(uint256 => address) public firstWinner;
    mapping(uint256 => uint8) public lastPhase;
    mapping(uint256 => bytes32) public pinnedPolicy;
    mapping(uint256 => Request) public lastRequest;
    mapping(uint8 => mapping(uint8 => uint256)) public edges;
    uint256 public donated;
    uint256 public illegalEdges;
    bool public winnerChanged;
    bool public policyChanged;
    uint256 public calls;
    uint256 public accepted;

    constructor() {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        vrfA = new MockVRF();
        vrfB = new MockVRF();
        owners = [address(this), makeAddr("second owner")];
        sellers = [makeAddr("seller one"), makeAddr("seller two")];
        treasuries = [makeAddr("treasury one"), makeAddr("treasury two")];
        buyers = [makeAddr("buyer one"), makeAddr("buyer two"), makeAddr("buyer three"), makeAddr("buyer four")];
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: treasuries[0],
                usdc: address(usdc),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 0,
                vrfCoordinator: address(vrfA),
                keyHash: keccak256("key"),
                subscriptionId: 1,
                termsHash: keccak256("terms"),
                callbackGasLimit: 400_000,
                requestConfirmations: 3
            })
        );
        labx.setPaused(false);
        for (uint256 i; i < sellers.length; ++i) {
            vm.prank(sellers[i]);
            nft.setApprovalForAll(address(labx), true);
        }
        for (uint256 i; i < buyers.length; ++i) {
            usdc.mint(buyers[i], 1e15);
            vm.prank(buyers[i]);
            usdc.approve(address(labx), type(uint256).max);
        }
        usdc.mint(outsider, 1e12);
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    // --- plumbing ---

    /// @dev Mostly an existing raffle, sometimes the next id, which does not exist yet.
    function _pick(uint256 seed) internal view returns (uint256) {
        if (ids.length == 0 || seed % 16 == 15) return labx.nextId();
        return ids[seed % ids.length];
    }

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    /// @dev Calls the raffle as `from`, books any USDC movement to raffle `id`, and records every phase change.
    function _call(address from, uint256 id, bytes memory data) internal returns (bool ok) {
        uint256 beforeBalance = usdc.balanceOf(address(labx));
        vm.prank(from);
        (ok,) = address(labx).call(data);
        uint256 afterBalance = usdc.balanceOf(address(labx));
        if (afterBalance > beforeBalance) paidIn[id] += afterBalance - beforeBalance;
        else paidOut[id] += beforeBalance - afterBalance;
        calls += 1;
        if (ok) accepted += 1;
        _observe();
    }

    /// @dev Calls and asserts the documented guard predicted the outcome.
    function _expect(bool predicted, address from, uint256 id, bytes memory data, string memory what)
        internal
        returns (bool ok)
    {
        ok = _call(from, id, data);
        assertEq(ok, predicted, what);
    }

    function _legal(uint8 from, uint8 to) internal pure returns (bool) {
        if (from == 0) return to == 1 || to == 6;
        if (from == 1) return to == 2 || to == 6;
        if (from == 2) return to == 3 || to == 6;
        if (from == 3) return to == 4 || to == 6;
        return from == 4 && to == 5;
    }

    function _observe() internal {
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            LabxRaffle.RaffleView memory r = labx.getRaffle(id);
            uint8 phase = uint8(r.phase);
            uint8 was = lastPhase[id];
            if (phase != was) {
                if (!_legal(was, phase)) illegalEdges += 1;
                edges[was][phase] += 1;
                if (was == 3 && phase == 4) draws[id] += 1;
                lastPhase[id] = phase;
            }
            if (r.winner != address(0)) {
                if (firstWinner[id] == address(0)) firstWinner[id] = r.winner;
                else if (firstWinner[id] != r.winner) winnerChanged = true;
            }
            LabxRaffle.RafflePolicy memory policy = labx.getRafflePolicy(id);
            if (policy.coordinator != address(0)) {
                bytes32 digest = keccak256(abi.encode(policy));
                if (pinnedPolicy[id] == bytes32(0)) pinnedPolicy[id] = digest;
                else if (pinnedPolicy[id] != digest) policyChanged = true;
            }
        }
    }

    function _configs(uint256 seed) internal pure returns (LabxRaffle.PackConfig[] memory configs) {
        configs = new LabxRaffle.PackConfig[](1 + seed % 3);
        for (uint256 i; i < configs.length; ++i) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            configs[i] = LabxRaffle.PackConfig({
                name: "Pack",
                priceUsdc: uint128(1e6 + h % 500e6),
                bonusEntries: uint32(1 + (h >> 64) % 50),
                maxSupply: uint32(1 + (h >> 128) % 30)
            });
        }
    }

    function _commit(uint256 token) internal view returns (bytes32) {
        return labx.hashCommitment(bytes32(token), address(nft), token, PUBLIC_HASH, PRIVATE_HASH, SALT);
    }

    function _admitted(uint256 id) internal view returns (bool) {
        LabxRaffle.RaffleAdmission memory admission = labx.getRaffleAdmission(id);
        if (admission.approvedBy != labx.owner() || admission.approvedReviewHash == bytes32(0)) return false;
        try labx.draftReviewHash(id) returns (bytes32 current) {
            return admission.approvedReviewHash == current;
        } catch {
            return false;
        }
    }

    /// @dev The zero address cannot send a transaction, so a raffle that does not exist is called by the outsider.
    function _or(address who) internal view returns (address) {
        return who == address(0) ? outsider : who;
    }

    function _held(LabxRaffle.RaffleView memory r) internal view returns (bool) {
        return r.escrowed && nft.ownerOf(r.tokenId) == address(labx);
    }

    // --- seller lifecycle ---

    function create(uint256 sellerSeed, uint256 endSeed, uint256 packSeed) public {
        if (ids.length >= MAX_RAFFLES) return;
        address seller = sellers[sellerSeed % sellers.length];
        uint256 token = nextToken++;
        nft.mint(seller, token);
        uint64 end = uint64(_now() + bound(endSeed, 1 hours, 3 days));
        ids.push(labx.nextId());
        _expect(
            true,
            seller,
            0,
            abi.encodeCall(
                LabxRaffle.createRaffle,
                (address(nft), token, end, bytes32(token), _commit(token), "Raffle", _configs(packSeed))
            ),
            "create"
        );
    }

    function updateDraft(uint256 idSeed, uint256 endSeed, uint256 packSeed, bool asSeller) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asSeller ? _or(r.seller) : outsider;
        uint64 end = uint64(_now() + bound(endSeed, 1 hours, 3 days));
        _expect(
            from == r.seller && r.phase == LabxRaffle.Phase.Draft,
            from,
            id,
            abi.encodeCall(
                LabxRaffle.updateDraft,
                (id, address(nft), r.tokenId, end, bytes32(r.tokenId), _commit(r.tokenId), "Edited", _configs(packSeed))
            ),
            "updateDraft"
        );
    }

    function escrow(uint256 idSeed, bool asSeller) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asSeller ? _or(r.seller) : outsider;
        _expect(
            from == r.seller && r.phase == LabxRaffle.Phase.Draft && !r.escrowed,
            from,
            id,
            abi.encodeCall(LabxRaffle.escrow, (id)),
            "escrow"
        );
    }

    function approve(uint256 idSeed, bool asOwner, bool revoke) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asOwner ? labx.owner() : outsider;
        bytes32 digest;
        try labx.draftReviewHash(id) returns (bytes32 current) {
            digest = current;
        } catch {}
        bool draft = r.seller != address(0) && r.phase == LabxRaffle.Phase.Draft && asOwner;
        if (revoke) {
            _expect(
                draft && labx.getRaffleAdmission(id).approvedReviewHash != bytes32(0),
                from,
                id,
                abi.encodeCall(LabxRaffle.revokeRaffleApproval, (id, digest)),
                "revoke"
            );
        } else {
            _expect(
                draft && _now() < r.salesEnd && _held(r),
                from,
                id,
                abi.encodeCall(LabxRaffle.approveRaffle, (id, digest)),
                "approve"
            );
        }
    }

    function open(uint256 idSeed, bool asSeller, bool checked) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asSeller ? _or(r.seller) : outsider;
        bool predicted = !labx.paused() && from == r.seller && r.phase == LabxRaffle.Phase.Draft && _now() < r.salesEnd
            && _admitted(id) && _held(r);
        bytes memory data = checked
            ? abi.encodeCall(LabxRaffle.openWithPolicy, (id, labx.openingPolicyHash()))
            : abi.encodeCall(LabxRaffle.open, (id));
        _expect(predicted, from, id, data, "open");
    }

    // --- buyers ---

    function buy(uint256 idSeed, uint256 buyerSeed, uint256 packSeed, uint256 qtySeed) public {
        uint256 id = _pick(idSeed);
        address buyer = buyers[buyerSeed % buyers.length];
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        // One past the last pack, and quantities 0 and 21, are invalid on purpose.
        uint8 packId = uint8(bound(packSeed, 0, r.packCount));
        uint32 qty = uint32(bound(qtySeed, 0, 21));
        LabxRaffle.Pack memory pack = labx.getPack(id, packId);
        bool predicted = !labx.paused() && r.phase == LabxRaffle.Phase.Open && _now() < r.salesEnd && qty != 0
            && qty <= 20 && packId < r.packCount && uint256(pack.sold) + qty <= pack.maxSupply;
        uint256 principalBefore = labx.principalOf(id, buyer);
        uint256 feeBefore = labx.feeOf(id, buyer);
        uint256 lots = labx.lotCount(id);
        bytes32 terms = labx.getRafflePolicy(id).termsHash;
        if (_expect(predicted, buyer, id, abi.encodeCall(LabxRaffle.buyPack, (id, packId, qty, terms)), "buy")) {
            grossPrincipal[id] += labx.principalOf(id, buyer) - principalBefore;
            buyerFees[id] += labx.feeOf(id, buyer) - feeBefore;
            assertEq(labx.lotCount(id), lots + 1, "one lot per purchase");
            entries[id] += labx.lotAt(id, lots).amount;
        }
    }

    function refund(uint256 idSeed, uint256 buyerSeed) public {
        uint256 id = _pick(idSeed);
        address buyer = buyers[buyerSeed % buyers.length];
        uint256 owed = labx.principalOf(id, buyer);
        uint256 balance = usdc.balanceOf(buyer);
        bool predicted = labx.getRaffle(id).phase == LabxRaffle.Phase.Cancelled && owed != 0;
        if (_expect(predicted, buyer, id, abi.encodeCall(LabxRaffle.refund, (id)), "refund")) {
            assertEq(usdc.balanceOf(buyer) - balance, owed, "refund pays the buyer's principal");
            refunded[id] += owed;
            refunds[id][buyer] += 1;
        }
    }

    // --- draw ---

    function close(uint256 idSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        _expect(
            r.phase == LabxRaffle.Phase.Open && _now() >= r.salesEnd,
            outsider,
            id,
            abi.encodeCall(LabxRaffle.close, (id)),
            "close"
        );
    }

    function snapshot(uint256 idSeed, uint256 steps) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        steps = bound(steps, 0, 3);
        _expect(
            steps != 0 && r.phase == LabxRaffle.Phase.Closed && !r.snapshotted,
            outsider,
            id,
            abi.encodeCall(LabxRaffle.snapshot, (id, steps)),
            "snapshot"
        );
    }

    function request(uint256 idSeed, uint256 callerSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = callerSeed % 2 == 0 ? outsider : buyers[callerSeed % buyers.length];
        bool predicted = r.phase == LabxRaffle.Phase.Closed && r.snapshotted && r.snapshotTotal != 0
            && _now() < uint256(r.salesEnd) + WEEK;
        if (_expect(predicted, from, id, abi.encodeCall(LabxRaffle.requestRandomness, (id)), "request")) {
            Request memory made =
                Request({coordinator: labx.getRafflePolicy(id).coordinator, id: labx.getRaffle(id).vrfRequestId});
            requests.push(made);
            lastRequest[id] = made;
        }
    }

    /// @dev mode 0: the pinned coordinator answers the live request. 1: the other coordinator sends the same id.
    ///      2: any request ever made is answered again by its coordinator. 3: the pinned coordinator sends no words.
    function fulfill(uint256 idSeed, uint256 word, uint256 mode) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address pinned = _or(labx.getRafflePolicy(id).coordinator);
        address from = pinned;
        uint256 requestId = r.vrfRequestId;
        mode = mode % 4;
        if (mode == 1) from = pinned == address(vrfA) ? address(vrfB) : address(vrfA);
        if (mode == 2 && requests.length != 0) {
            Request memory old = requests[word % requests.length];
            from = old.coordinator;
            requestId = old.id;
        }
        uint256[] memory words = new uint256[](mode == 3 ? 0 : 1);
        if (mode != 3) words[0] = word;
        bool draws_ = r.phase == LabxRaffle.Phase.Drawing && from == pinned && requestId == r.vrfRequestId
            && words.length != 0 && _now() < uint256(r.vrfRequestedAt) + WEEK;
        _expect(true, from, id, abi.encodeCall(LabxRaffle.rawFulfillRandomWords, (requestId, words)), "callback");
        assertEq(
            uint8(labx.getRaffle(id).phase),
            draws_ ? uint8(LabxRaffle.Phase.Drawn) : uint8(r.phase),
            "only the pinned coordinator's live request, in time, draws"
        );
    }

    function abort(uint256 idSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        _expect(
            r.phase == LabxRaffle.Phase.Drawing && _now() >= uint256(r.vrfRequestedAt) + WEEK,
            outsider,
            id,
            abi.encodeCall(LabxRaffle.abortDrawing, (id)),
            "abort"
        );
    }

    function cancel(uint256 idSeed, uint256 actorSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = [_or(r.seller), labx.owner(), outsider, buyers[0]][actorSeed % 4];
        bool privileged = from == r.seller || from == labx.owner();
        bool live = r.phase == LabxRaffle.Phase.Open || r.phase == LabxRaffle.Phase.Closed;
        bool expired = live && _now() >= uint256(r.salesEnd) + WEEK;
        // The documented rule, without the contract's empty-snapshot exemption: the handler fails if that exemption
        // ever lets a cancel through.
        bool predicted = r.seller != address(0) && (r.phase == LabxRaffle.Phase.Draft || live)
            && (expired || (privileged && labx.lotCount(id) == 0));
        _expect(predicted, from, id, abi.encodeCall(LabxRaffle.cancel, (id)), "cancel");
    }

    function reveal(uint256 idSeed, uint256 actorSeed, bool honest) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = [_or(r.seller), labx.owner(), outsider][actorSeed % 3];
        bool predicted = (from == r.seller || from == labx.owner()) && !r.revealed && honest
            && r.phase != LabxRaffle.Phase.Draft && r.phase != LabxRaffle.Phase.Settled
            && r.phase != LabxRaffle.Phase.Cancelled;
        _expect(
            predicted,
            from,
            id,
            abi.encodeCall(LabxRaffle.reveal, (id, PUBLIC_HASH, PRIVATE_HASH, honest ? SALT : bytes32(0))),
            "reveal"
        );
    }

    function settle(uint256 idSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        _expect(
            r.phase == LabxRaffle.Phase.Drawn && (r.revealed || _now() >= uint256(r.drawnAt) + WEEK),
            outsider,
            id,
            abi.encodeCall(LabxRaffle.settle, (id)),
            "settle"
        );
    }

    // --- payouts ---

    function claimPrize(uint256 idSeed, uint256 actorSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = actorSeed % 3 == 0 ? buyers[actorSeed % buyers.length] : _or(r.winner);
        bool predicted = r.phase == LabxRaffle.Phase.Settled && from == r.winner && r.escrowed;
        if (_expect(predicted, from, id, abi.encodeCall(LabxRaffle.claimPrize, (id)), "claimPrize")) {
            prizeReleases[id] += 1;
        }
    }

    function reclaimPrize(uint256 idSeed, bool asSeller) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asSeller ? _or(r.seller) : outsider;
        bool predicted = r.phase == LabxRaffle.Phase.Cancelled && from == r.seller && r.escrowed;
        if (_expect(predicted, from, id, abi.encodeCall(LabxRaffle.reclaimPrize, (id)), "reclaimPrize")) {
            prizeReleases[id] += 1;
        }
    }

    function claimProceeds(uint256 idSeed, bool asSeller) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address from = asSeller ? _or(r.seller) : outsider;
        uint256 balance = usdc.balanceOf(r.seller);
        bool predicted = r.phase == LabxRaffle.Phase.Settled && from == r.seller && r.principalEscrow != 0;
        if (_expect(predicted, from, id, abi.encodeCall(LabxRaffle.claimProceeds, (id)), "claimProceeds")) {
            proceedsPaid[id] += usdc.balanceOf(r.seller) - balance;
            proceedsClaims[id] += 1;
        }
    }

    function claimFee(uint256 idSeed) public {
        uint256 id = _pick(idSeed);
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        address payee = labx.getRafflePolicy(id).treasury;
        uint256 balance = usdc.balanceOf(payee);
        bool predicted =
            (r.phase == LabxRaffle.Phase.Settled || r.phase == LabxRaffle.Phase.Cancelled) && r.feeEscrow != 0;
        if (_expect(predicted, outsider, id, abi.encodeCall(LabxRaffle.claimFee, (id)), "claimFee")) {
            feesPaid[id] += usdc.balanceOf(payee) - balance;
        }
    }

    // --- owner, time and noise ---

    function admin(uint256 kind, uint256 seed, bool asOwner) public {
        address from = asOwner ? labx.owner() : outsider;
        bool predicted = asOwner;
        bytes memory data;
        kind = kind % 10;
        if (kind == 0) {
            // Pausing is rare so sales still happen; `advance` unpauses when it needs to.
            data = abi.encodeCall(LabxRaffle.setPaused, (seed % 4 == 0));
        } else if (kind == 1) {
            data = abi.encodeCall(LabxRaffle.setTreasury, (treasuries[seed % 2]));
        } else if (kind == 2) {
            data = abi.encodeCall(LabxRaffle.setTermsHash, (bytes32(seed | 1)));
        } else if (kind == 3) {
            data = abi.encodeCall(
                LabxRaffle.setVrfConfig,
                (bytes32(seed | 1), 1 + seed % 5, uint32(200_000 + seed % 1_000_000), uint16(3 + seed % 100))
            );
        } else if (kind == 4) {
            data = abi.encodeCall(LabxRaffle.setNativePayment, (seed % 2 == 0));
        } else if (kind == 5) {
            data = abi.encodeCall(LabxRaffle.proposeCoordinator, (seed % 2 == 0 ? address(vrfA) : address(vrfB)));
        } else if (kind == 6) {
            data = abi.encodeCall(LabxRaffle.applyCoordinator, ());
            predicted = asOwner && labx.pendingCoordinator() != address(0) && _now() >= labx.coordinatorEta();
        } else if (kind == 7) {
            data = abi.encodeCall(LabxRaffle.transferOwnership, (owners[seed % 2]));
        } else if (kind == 8) {
            data = abi.encodeCall(LabxRaffle.acceptOwnership, ());
            predicted = asOwner && labx.pendingOwner() != address(0);
            from = predicted ? labx.pendingOwner() : outsider;
        } else {
            // The ETH route is not wired, as on mainnet, so it can be switched off but never on.
            data = abi.encodeCall(LabxRaffle.setEthPathEnabled, (seed % 2 == 0));
            predicted = asOwner && seed % 2 != 0;
        }
        _expect(predicted, from, 0, data, "admin");
    }

    function warp(uint256 seed) public {
        uint256[4] memory steps = [uint256(20 minutes), 1 days, 3 days, WEEK];
        vm.warp(_now() + steps[seed % 4]);
    }

    /// @dev Lands exactly on, or one second before, a deadline of the picked raffle.
    function warpToDeadline(uint256 idSeed, uint256 which) public {
        LabxRaffle.RaffleView memory r = labx.getRaffle(_pick(idSeed));
        uint256[4] memory deadlines = [
            uint256(r.salesEnd),
            uint256(r.salesEnd) + WEEK,
            r.vrfRequestedAt == 0 ? 0 : uint256(r.vrfRequestedAt) + WEEK,
            r.drawnAt == 0 ? 0 : uint256(r.drawnAt) + WEEK
        ];
        uint256 target = deadlines[which % 4];
        if (target == 0) return;
        if (which % 8 >= 4) target -= 1;
        if (target > _now()) vm.warp(target);
    }

    /// @dev USDC sent straight to the contract belongs to no raffle.
    function donate(uint256 amount) public {
        amount = bound(amount, 1, 1_000e6);
        vm.prank(outsider);
        usdc.transfer(address(labx), amount);
        donated += amount;
    }

    /// @dev Takes the next legal lifecycle step for one raffle, so runs reach every phase.
    function advance(uint256 seed) public {
        if (ids.length < 2 || (ids.length < MAX_RAFFLES && seed % 11 == 0)) {
            create(seed, seed, seed);
            return;
        }
        uint256 index = seed % ids.length;
        uint256 id = ids[index];
        LabxRaffle.RaffleView memory r = labx.getRaffle(id);
        if (r.phase == LabxRaffle.Phase.Draft) {
            if (_now() >= r.salesEnd) {
                updateDraft(index, seed, seed, true);
            } else if (!r.escrowed) {
                escrow(index, true);
            } else if (!_admitted(id)) {
                approve(index, true, false);
            } else {
                _unpause();
                open(index, true, seed % 2 == 0);
            }
        } else if (r.phase == LabxRaffle.Phase.Open) {
            if (_now() < r.salesEnd && labx.lotCount(id) < 2 + seed % 4) {
                _unpause();
                buy(index, seed >> 8, seed >> 16, 1 + (seed >> 24) % 20);
            } else {
                if (_now() < r.salesEnd) vm.warp(r.salesEnd);
                close(index);
            }
        } else if (r.phase == LabxRaffle.Phase.Closed) {
            // One raffle in seven misses the draw deadline, with whatever snapshot progress it has.
            if (seed % 7 == 0 && _now() < uint256(r.salesEnd) + WEEK) vm.warp(uint256(r.salesEnd) + WEEK);
            if (_now() >= uint256(r.salesEnd) + WEEK) cancel(index, 2);
            else if (!r.snapshotted) snapshot(index, 1 + seed % 3);
            else request(index, seed);
        } else if (r.phase == LabxRaffle.Phase.Drawing) {
            // One draw in five is never answered in time.
            if (seed % 5 == 0 && _now() < uint256(r.vrfRequestedAt) + WEEK) vm.warp(uint256(r.vrfRequestedAt) + WEEK);
            if (_now() >= uint256(r.vrfRequestedAt) + WEEK) abort(index);
            else fulfill(index, seed, 0);
        } else if (r.phase == LabxRaffle.Phase.Drawn) {
            if (!r.revealed && seed % 2 == 0) {
                reveal(index, 0, true);
            } else {
                if (!r.revealed && _now() < uint256(r.drawnAt) + WEEK) vm.warp(uint256(r.drawnAt) + WEEK);
                settle(index);
            }
        } else if (r.phase == LabxRaffle.Phase.Settled) {
            if (seed % 3 == 0) claimPrize(index, 1);
            else if (seed % 3 == 1) claimProceeds(index, true);
            else claimFee(index);
        } else {
            if (seed % 3 == 0) reclaimPrize(index, true);
            else if (seed % 3 == 1) refund(index, seed >> 8);
            else claimFee(index);
        }
    }

    function _unpause() internal {
        if (labx.paused()) _call(labx.owner(), 0, abi.encodeCall(LabxRaffle.setPaused, (false)));
    }

    /// @dev Extra selectors for `advance`, so the fuzzer picks the forward path more often than any single guard probe.
    function advanceAgain(uint256 seed) external {
        advance(seed);
    }

    function advanceOnceMore(uint256 seed) external {
        advance(seed);
    }

    /// @dev Several forward steps in one call, on raffles chosen afresh for each.
    function advanceMany(uint256 seed, uint256 steps) external {
        steps = bound(steps, 2, 6);
        for (uint256 i; i < steps; ++i) {
            advance(uint256(keccak256(abi.encode(seed, i))));
        }
    }
}

contract StateMachineInvariantTest is Test {
    RaffleHandler internal handler;
    LabxRaffle internal labx;
    MockERC20 internal usdc;
    MockERC721 internal nft;

    function setUp() public {
        handler = new RaffleHandler();
        labx = handler.labx();
        usdc = handler.usdc();
        nft = handler.nft();
        targetContract(address(handler));
    }

    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 300
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_accountingCustodyAndPhaseRulesHold() public view {
        _checkAll();
    }

    /// @dev The forward path alone, checked after every step, so the invariants are known to be exercised in every
    ///      phase whatever the fuzzer happens to pick.
    function test_handlerReachesEveryPhaseAndTheInvariantsHoldAtEachStep() public {
        for (uint256 seed = 1; seed <= 400; ++seed) {
            handler.advance(uint256(keccak256(abi.encode(seed))));
            if (seed % 25 == 0) handler.warp(seed / 25);
            this.checkAll();
        }
        // Every forward edge of the phase graph was taken, and at least one raffle ended in each terminal phase.
        assertGt(handler.edges(0, 1), 0, "Draft to Open");
        assertGt(handler.edges(1, 2), 0, "Open to Closed");
        assertGt(handler.edges(2, 3), 0, "Closed to Drawing");
        assertGt(handler.edges(3, 4), 0, "Drawing to Drawn");
        assertGt(handler.edges(4, 5), 0, "Drawn to Settled");
        assertGt(handler.edges(1, 6) + handler.edges(2, 6) + handler.edges(3, 6), 0, "a funded raffle to Cancelled");
        emit log_named_uint("calls", handler.calls());
        emit log_named_uint("accepted", handler.accepted());
        for (uint8 from; from < 5; ++from) {
            for (uint8 to = 1; to < 7; ++to) {
                if (handler.edges(from, to) != 0) {
                    emit log_named_uint(
                        string.concat("edge ", vm.toString(from), " to ", vm.toString(to)), handler.edges(from, to)
                    );
                }
            }
        }
    }

    /// @dev External so each check runs in its own call frame and frees its memory.
    function checkAll() external view {
        _checkAll();
    }

    function _checkAll() internal view {
        uint256 held;
        uint256 drawing;
        uint256 escrowedCount;
        uint256 count = handler.idCount();
        for (uint256 i; i < count; ++i) {
            uint256 id = handler.ids(i);
            LabxRaffle.RaffleView memory r = labx.getRaffle(id);
            held += r.principalEscrow + r.feeEscrow;
            if (r.phase == LabxRaffle.Phase.Drawing) drawing += 1;
            if (r.escrowed) escrowedCount += 1;
            _checkMoney(id, r);
            _checkDraw(id, r);
            _checkSnapshot(id, r);
            _checkCustody(id, r);
            _checkAdmission(id, r);
        }
        assertEq(usdc.balanceOf(address(labx)), held + handler.donated(), "USDC held = every escrow + unsolicited");
        assertEq(labx.activeDrawings(), drawing, "activeDrawings counts the raffles in Drawing");
        assertEq(nft.balanceOf(address(labx)), escrowedCount, "one held token per escrowed raffle");
        assertEq(labx.nextId(), count + 1, "ids are dense");
        assertEq(handler.illegalEdges(), 0, "no phase change outside the transition table");
        assertFalse(handler.winnerChanged(), "a winner never changes");
        assertFalse(handler.policyChanged(), "a pinned policy never changes");
    }

    function _checkMoney(uint256 id, LabxRaffle.RaffleView memory r) internal view {
        uint256 gross = handler.grossPrincipal(id);
        uint256 fees = handler.buyerFees(id);
        uint256 commission = gross * 200 / 10_000;
        uint256 owedToBuyers;
        for (uint256 b; b < 4; ++b) {
            address buyer = handler.buyers(b);
            owedToBuyers += labx.principalOf(id, buyer);
            assertLe(handler.refunds(id, buyer), 1, "a buyer is refunded once");
        }
        assertEq(handler.paidIn(id), gross + fees, "money in = principal + buyer fees");
        assertEq(handler.paidIn(id) - handler.paidOut(id), r.principalEscrow + r.feeEscrow, "in - out = escrow");
        LabxRaffle.RaffleAccounting memory lifetime = labx.getRaffleAccounting(id);
        assertEq(lifetime.grossPrincipal, gross, "lifetime principal");
        assertEq(lifetime.buyerFees, fees, "lifetime buyer fees");
        assertLe(handler.proceedsClaims(id), 1, "proceeds are claimed once");
        assertLe(handler.prizeReleases(id), 1, "the prize leaves once");

        if (r.phase == LabxRaffle.Phase.Settled) {
            assertEq(r.principalEscrow + handler.proceedsPaid(id), gross - commission, "seller net");
            assertEq(r.feeEscrow + handler.feesPaid(id), fees + commission, "fees + commission");
            assertEq(handler.refunded(id), 0, "no refund from a settled raffle");
            assertEq(owedToBuyers, gross, "settling leaves purchase records alone");
        } else if (r.phase == LabxRaffle.Phase.Cancelled) {
            assertEq(r.principalEscrow + handler.refunded(id), gross, "principal is refunded or still held");
            assertEq(r.principalEscrow, owedToBuyers, "held principal = unrefunded buyers");
            assertEq(r.feeEscrow + handler.feesPaid(id), fees, "buyer fees are kept, never refunded");
            assertEq(handler.proceedsPaid(id), 0, "no proceeds from a cancelled raffle");
        } else {
            assertEq(r.principalEscrow, gross, "principal held in full before an outcome");
            assertEq(r.principalEscrow, owedToBuyers, "held principal = buyers' principal");
            assertEq(r.feeEscrow, fees, "fees held in full before an outcome");
            assertEq(handler.paidOut(id), 0, "nothing leaves before an outcome");
        }
    }

    function _checkDraw(uint256 id, LabxRaffle.RaffleView memory r) internal view {
        address coordinator = labx.getRafflePolicy(id).coordinator;
        (address lastCoordinator, uint256 lastId) = handler.lastRequest(id);
        if (r.phase == LabxRaffle.Phase.Drawing) {
            assertGt(r.vrfRequestId, 0, "a Drawing raffle has a request");
            assertEq(labx.requestToRaffle(coordinator, r.vrfRequestId), id, "the request maps to its raffle");
            assertTrue(labx.requestUsed(coordinator, r.vrfRequestId), "the request id is spent");
            assertTrue(r.snapshotted && r.snapshotTotal != 0, "drawing needs a complete, non-empty snapshot");
            assertEq(handler.draws(id), 0, "not drawn yet");
        } else if (r.phase == LabxRaffle.Phase.Drawn || r.phase == LabxRaffle.Phase.Settled) {
            assertEq(handler.draws(id), 1, "drawn exactly once");
            assertEq(r.winner, handler.firstWinner(id), "the first winner stands");
            assertGt(labx.principalOf(id, r.winner), 0, "the winner bought a pack");
            assertEq(r.vrfRequestId, lastId, "the one request is the one fulfilled");
            assertTrue(r.drawnAt >= r.vrfRequestedAt && r.drawnAt < uint256(r.vrfRequestedAt) + 7 days, "drawn in time");
        } else {
            assertEq(handler.draws(id), 0, "never drawn");
        }
        if (r.phase != LabxRaffle.Phase.Drawn && r.phase != LabxRaffle.Phase.Settled) {
            assertEq(r.winner, address(0), "no winner outside Drawn and Settled");
            assertEq(r.drawnAt, 0, "no draw time outside Drawn and Settled");
            assertEq(r.randomWord, 0, "no random word outside Drawn and Settled");
        }
        if (uint8(r.phase) < uint8(LabxRaffle.Phase.Drawing)) {
            assertEq(r.vrfRequestId, 0, "no request before Drawing");
            assertEq(r.vrfRequestedAt, 0, "no request time before Drawing");
        }
        if (r.phase == LabxRaffle.Phase.Cancelled) {
            assertEq(r.vrfRequestId, 0, "a cancelled raffle holds no request");
            if (lastId != 0) {
                assertEq(labx.requestToRaffle(lastCoordinator, lastId), 0, "an aborted request is forgotten");
            }
        }
    }

    function _checkSnapshot(uint256 id, LabxRaffle.RaffleView memory r) internal view {
        uint256 lots = labx.lotCount(id);
        assertLe(r.lotCursor, lots, "the cursor never passes the lots");
        assertLe(r.snapshotTotal, handler.entries(id), "the snapshot never counts more than was sold");
        if (r.snapshotted) assertEq(r.lotCursor, lots, "a complete snapshot covers every lot");
        if (r.phase == LabxRaffle.Phase.Draft) assertEq(lots, 0, "no lots in Draft");
        if (r.phase == LabxRaffle.Phase.Draft || r.phase == LabxRaffle.Phase.Open) {
            assertTrue(r.lotCursor == 0 && !r.snapshotted && r.snapshotTotal == 0, "no counting before Closed");
        }
        if (
            r.phase == LabxRaffle.Phase.Drawing || r.phase == LabxRaffle.Phase.Drawn
                || r.phase == LabxRaffle.Phase.Settled
        ) {
            assertTrue(r.snapshotted, "a draw has a complete snapshot");
            assertEq(r.snapshotTotal, handler.entries(id), "a draw counts every entry sold");
            assertEq(labx.cumulatives(id, lots - 1), r.snapshotTotal, "the last cumulative is the total");
        }
    }

    function _checkCustody(uint256, LabxRaffle.RaffleView memory r) internal view {
        address holder = nft.ownerOf(r.tokenId);
        if (r.escrowed) {
            assertEq(holder, address(labx), "an escrowed raffle's token is held");
        } else {
            assertEq(holder, r.phase == LabxRaffle.Phase.Settled ? r.winner : r.seller, "released to the right party");
        }
        if (
            r.phase == LabxRaffle.Phase.Open || r.phase == LabxRaffle.Phase.Closed
                || r.phase == LabxRaffle.Phase.Drawing || r.phase == LabxRaffle.Phase.Drawn
        ) {
            assertTrue(r.escrowed, "the prize is held from Open to Drawn");
        }
    }

    function _checkAdmission(uint256 id, LabxRaffle.RaffleView memory r) internal view {
        LabxRaffle.RaffleAdmission memory admission = labx.getRaffleAdmission(id);
        LabxRaffle.RafflePolicy memory policy = labx.getRafflePolicy(id);
        bool pinned = policy.coordinator != address(0);
        assertEq(admission.approvedAtOpening, pinned, "a policy is pinned exactly when the raffle was opened");
        if (r.phase == LabxRaffle.Phase.Draft) {
            assertFalse(pinned, "a draft has no pinned policy");
        } else if (r.phase != LabxRaffle.Phase.Cancelled) {
            assertTrue(pinned, "every opened raffle has a pinned policy");
        }
        if (pinned) {
            assertTrue(policy.treasury != address(0) && policy.termsHash != bytes32(0), "a pinned policy is complete");
            assertTrue(policy.buyerFeeBps == 200 && policy.sellerFeeBps == 200, "fee rates are the constants");
            assertTrue(admission.approvedReviewHash != bytes32(0), "an opened raffle was approved");
        }
    }
}
