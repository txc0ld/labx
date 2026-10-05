// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxRoles} from "./base/LabxRoles.sol";
import {ILabxMembership} from "./interfaces/ILabxMembership.sol";
import {ILabxTerms} from "./interfaces/ILabxTerms.sol";

/// @title LabxDiscountMarketplace
/// @notice Member-only perks: partner offers gated by membership rank.
/// @dev Redemption is recorded on-chain and emits a deterministic `voucherRef`. The LABx backend watches
///      for `OfferRedeemed`, then issues the partner's code out-of-band, so no discount code is ever
///      written to a public chain.
contract LabxDiscountMarketplace is LabxRoles {
    struct Offer {
        address partner;
        uint8 minRank; // minimum membership rank; 0 means open to any wallet
        uint32 stock; // 0 = unlimited
        uint32 redeemed;
        uint32 perUserLimit; // 0 = unlimited
        uint64 startsAt;
        uint64 endsAt;
        uint16 discountBps;
        bool active;
        string uri; // offer metadata (title, partner, terms)
    }

    ILabxMembership public immutable membership;
    ILabxTerms public terms;

    Offer[] private _offers;
    mapping(uint256 offerId => mapping(address member => uint32)) public redemptions;

    event OfferCreated(
        uint256 indexed offerId,
        address indexed partner,
        uint8 minRank,
        uint16 discountBps,
        uint32 stock,
        uint64 startsAt,
        uint64 endsAt,
        string uri
    );
    event OfferUpdated(uint256 indexed offerId, uint32 stock, uint32 perUserLimit, uint64 endsAt, bool active);
    event OfferRedeemed(
        uint256 indexed offerId, address indexed member, uint32 nth, uint8 memberRank, bytes32 voucherRef
    );
    event TermsRegistryUpdated(address indexed registry);

    error UnknownOffer(uint256 offerId);
    error OfferInactive(uint256 offerId);
    error OfferNotStarted(uint64 startsAt);
    error OfferEnded(uint64 endsAt);
    error OutOfStock(uint256 offerId);
    error RankTooLow(uint8 required, uint8 actual);
    error PerUserLimitReached(uint32 limit);
    error InvalidOffer();

    constructor(address admin, address membership_) LabxRoles(admin) {
        if (membership_ == address(0)) revert ZeroAddress();
        membership = ILabxMembership(membership_);
    }

    function setTerms(address registry) external onlyRole(DEFAULT_ADMIN_ROLE) {
        terms = ILabxTerms(registry);
        emit TermsRegistryUpdated(registry);
    }

    function createOffer(
        address partner,
        uint8 minRank,
        uint16 discountBps,
        uint32 stock,
        uint32 perUserLimit,
        uint64 startsAt,
        uint64 endsAt,
        string calldata uri
    ) external onlyRole(CURATOR_ROLE) returns (uint256 offerId) {
        if (partner == address(0)) revert ZeroAddress();
        if (discountBps > 10_000 || endsAt <= startsAt || bytes(uri).length == 0) revert InvalidOffer();

        offerId = _offers.length;
        _offers.push(
            Offer({
                partner: partner,
                minRank: minRank,
                stock: stock,
                redeemed: 0,
                perUserLimit: perUserLimit,
                startsAt: startsAt,
                endsAt: endsAt,
                discountBps: discountBps,
                active: true,
                uri: uri
            })
        );
        emit OfferCreated(offerId, partner, minRank, discountBps, stock, startsAt, endsAt, uri);
    }

    function updateOffer(uint256 offerId, uint32 stock, uint32 perUserLimit, uint64 endsAt, bool active)
        external
        onlyRole(CURATOR_ROLE)
    {
        Offer storage offer = _requireOffer(offerId);
        if (endsAt <= offer.startsAt) revert InvalidOffer();
        offer.stock = stock;
        offer.perUserLimit = perUserLimit;
        offer.endsAt = endsAt;
        offer.active = active;
        emit OfferUpdated(offerId, stock, perUserLimit, endsAt, active);
    }

    /// @notice Claims a perk. The backend issues the partner code in response to `OfferRedeemed`.
    function redeem(uint256 offerId) external returns (bytes32 voucherRef) {
        Offer storage offer = _requireOffer(offerId);
        if (!offer.active) revert OfferInactive(offerId);
        if (block.timestamp < offer.startsAt) revert OfferNotStarted(offer.startsAt);
        if (block.timestamp >= offer.endsAt) revert OfferEnded(offer.endsAt);
        if (offer.stock != 0 && offer.redeemed >= offer.stock) revert OutOfStock(offerId);

        if (address(terms) != address(0)) terms.requireAccepted(msg.sender);

        uint8 rank = membership.memberRank(msg.sender);
        if (rank < offer.minRank) revert RankTooLow(offer.minRank, rank);

        uint32 used = redemptions[offerId][msg.sender];
        if (offer.perUserLimit != 0 && used >= offer.perUserLimit) revert PerUserLimitReached(offer.perUserLimit);

        uint32 nth = used + 1;
        redemptions[offerId][msg.sender] = nth;
        offer.redeemed += 1;

        voucherRef = keccak256(abi.encode(address(this), offerId, msg.sender, nth));
        emit OfferRedeemed(offerId, msg.sender, nth, rank, voucherRef);
    }

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function offers(uint256 offerId) external view returns (Offer memory) {
        return _requireOffer(offerId);
    }

    function allOffers() external view returns (Offer[] memory) {
        return _offers;
    }

    /// @notice Whether `member` can redeem `offerId` right now, and why not when they cannot.
    function canRedeem(uint256 offerId, address member) external view returns (bool ok, bytes32 reason) {
        if (offerId >= _offers.length) return (false, "unknown-offer");
        Offer storage offer = _offers[offerId];
        if (!offer.active) return (false, "inactive");
        if (block.timestamp < offer.startsAt) return (false, "not-started");
        if (block.timestamp >= offer.endsAt) return (false, "ended");
        if (offer.stock != 0 && offer.redeemed >= offer.stock) return (false, "out-of-stock");
        if (membership.memberRank(member) < offer.minRank) return (false, "rank-too-low");
        if (offer.perUserLimit != 0 && redemptions[offerId][member] >= offer.perUserLimit) {
            return (false, "per-user-limit");
        }
        if (address(terms) != address(0) && !terms.hasAcceptedAll(member)) return (false, "terms-not-accepted");
        return (true, bytes32(0));
    }

    function _requireOffer(uint256 offerId) private view returns (Offer storage offer) {
        if (offerId >= _offers.length) revert UnknownOffer(offerId);
        offer = _offers[offerId];
    }
}
