// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {LabxTerms} from "../../src/LabxTerms.sol";
import {LabxJurisdictionRegistry} from "../../src/LabxJurisdictionRegistry.sol";
import {LabxMembership} from "../../src/LabxMembership.sol";
import {LabxRaffleHouse} from "../../src/LabxRaffleHouse.sol";
import {LabxPoints} from "../../src/LabxPoints.sol";
import {LabxAmoeGateway} from "../../src/LabxAmoeGateway.sol";
import {LabxDiscountMarketplace} from "../../src/LabxDiscountMarketplace.sol";
import {LabxUniswapV3SwapAdapter} from "../../src/LabxUniswapV3SwapAdapter.sol";
import {LabxVRFConsumerBase} from "../../src/base/LabxVRFConsumerBase.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC721} from "../mocks/MockERC721.sol";
import {MockERC1155} from "../mocks/MockERC1155.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @notice Deploys and wires the whole LABx stack the same way `script/Deploy.s.sol` does, so tests
///         exercise the real role topology rather than a convenience setup.
abstract contract LabxTestBase is Test {
    // Roles are held by the Fantom Labs Safe in production; a plain EOA stands in for it here.
    address internal safe = makeAddr("safe");
    address internal treasury = makeAddr("treasury");
    address internal operator = makeAddr("operator");
    address internal curator = makeAddr("curator");
    address internal seller = makeAddr("seller");

    uint256 internal attestorKey = 0xA11CE;
    address internal attestor;

    uint256 internal sellerKey = 0xBEEF;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockERC20 internal usdc;
    MockERC721 internal nft;
    MockERC1155 internal nft1155;
    MockSwapRouter internal router;
    MockAggregatorV3 internal ethUsdFeed;
    MockVRFCoordinatorV2Plus internal vrf;

    LabxTerms internal terms;
    LabxJurisdictionRegistry internal jurisdiction;
    LabxMembership internal membership;
    LabxRaffleHouse internal raffleHouse;
    LabxPoints internal points;
    LabxAmoeGateway internal amoe;
    LabxDiscountMarketplace internal marketplace;
    LabxUniswapV3SwapAdapter internal swapAdapter;

    // Membership packs. Prices are chosen so `price / entries` divides cleanly.
    uint8 internal constant TIER_ENTRY = 0;
    uint8 internal constant TIER_BRONZE = 1;
    uint8 internal constant TIER_SILVER = 2;
    uint8 internal constant TIER_GOLD = 3;
    uint8 internal constant TIER_PLATINUM = 4;

    uint256 internal constant ETH_USD = 3_000e8;
    uint256 internal constant USDC_PER_ETH = 3_000e6;

    function setUp() public virtual {
        attestor = vm.addr(attestorKey);
        sellerKey = 0xBEEF;
        seller = vm.addr(sellerKey);

        usdc = new MockERC20("USD Coin", "USDC", 6);
        nft = new MockERC721();
        nft1155 = new MockERC1155();
        router = new MockSwapRouter(address(usdc), USDC_PER_ETH);
        ethUsdFeed = new MockAggregatorV3(8, int256(ETH_USD));
        vrf = new MockVRFCoordinatorV2Plus();

        terms = new LabxTerms(safe);
        jurisdiction = new LabxJurisdictionRegistry(safe);
        membership = new LabxMembership(safe, address(usdc), treasury);
        swapAdapter =
            new LabxUniswapV3SwapAdapter(safe, address(router), address(usdc), address(1), address(ethUsdFeed));
        raffleHouse = new LabxRaffleHouse(
            safe,
            address(usdc),
            address(membership),
            treasury,
            address(vrf),
            LabxVRFConsumerBase.VrfConfig({
                keyHash: keccak256("labx-sepolia-keyhash"),
                subscriptionId: 42,
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                nativePayment: false
            })
        );
        points = new LabxPoints(safe, address(membership));
        amoe = new LabxAmoeGateway(safe, address(raffleHouse));
        marketplace = new LabxDiscountMarketplace(safe, address(membership));

        vm.startPrank(safe);

        // Legal documents: two required tick-boxes.
        terms.publish(terms.TERMS_OF_USE(), "https://labx.art/legal/terms", keccak256("terms-v1"));
        terms.publish(terms.RAFFLE_RULES(), "https://labx.art/legal/raffle-rules", keccak256("rules-v1"));
        terms.setRequired(terms.TERMS_OF_USE(), true);
        terms.setRequired(terms.RAFFLE_RULES(), true);
        terms.grantRole(terms.ATTESTOR_ROLE(), attestor);

        jurisdiction.grantRole(jurisdiction.ATTESTOR_ROLE(), attestor);

        membership.setTerms(address(terms));
        membership.setJurisdiction(address(jurisdiction));
        membership.setSwapAdapter(address(swapAdapter));
        membership.grantRole(membership.ENTRY_SPENDER_ROLE(), address(raffleHouse));
        membership.grantRole(membership.PURCHASE_ROUTER_ROLE(), address(raffleHouse));
        membership.grantRole(membership.ENTRY_ISSUER_ROLE(), address(points));
        membership.grantRole(membership.OPERATIONS_ROLE(), operator);

        // Price / entries divides exactly for each pack, so value-per-entry is a round number:
        // $5.00, $4.50, $4.00, $3.50, $3.00 respectively.
        membership.addTier("Entry", 25e6, 5, 0, 1);
        membership.addTier("Bronze", 54e6, 12, 250, 2);
        membership.addTier("Silver", 100e6, 25, 500, 3);
        membership.addTier("Gold", 245e6, 70, 750, 4);
        membership.addTier("Platinum", 450e6, 150, 1_000, 5);

        raffleHouse.setTerms(address(terms));
        raffleHouse.setJurisdiction(address(jurisdiction));
        raffleHouse.grantRole(raffleHouse.OPERATIONS_ROLE(), operator);
        raffleHouse.grantRole(raffleHouse.CURATOR_ROLE(), curator);
        raffleHouse.grantRole(raffleHouse.ENTRY_ISSUER_ROLE(), address(amoe));

        amoe.grantRole(amoe.ATTESTOR_ROLE(), attestor);

        points.grantRole(points.ATTESTOR_ROLE(), attestor);
        points.grantRole(points.OPERATIONS_ROLE(), operator);

        marketplace.setTerms(address(terms));
        marketplace.grantRole(marketplace.CURATOR_ROLE(), curator);

        vm.stopPrank();

        // Liquidity for the mock pool, and spending money for the test wallets.
        usdc.mint(address(router), 10_000_000e6);
        for (uint256 i; i < 3; ++i) {
            address user = i == 0 ? alice : (i == 1 ? bob : carol);
            usdc.mint(user, 1_000_000e6);
            vm.deal(user, 1_000 ether);
            vm.prank(user);
            usdc.approve(address(membership), type(uint256).max);
            _acceptTerms(user);
        }
        vm.deal(seller, 10 ether);
        _acceptTerms(seller);
    }

    // --------------------------------------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------------------------------------

    /// @dev Always read the clock through this. The Solidity optimizer treats `block.timestamp` as
    ///      constant for the whole function, so a test that calls `vm.warp` between statements would
    ///      otherwise keep seeing the pre-warp value. The cheatcode is an external call, so it cannot
    ///      be folded away.
    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _acceptTerms(address user) internal {
        bytes32[] memory keys = new bytes32[](2);
        uint32[] memory versions = new uint32[](2);
        keys[0] = terms.TERMS_OF_USE();
        keys[1] = terms.RAFFLE_RULES();
        versions[0] = terms.currentVersion(keys[0]);
        versions[1] = terms.currentVersion(keys[1]);
        vm.prank(user);
        terms.accept(keys, versions);
    }

    function _reserveCommitment(uint256 reserveUsdc, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(reserveUsdc, salt));
    }

    function _defaultRaffleParams(uint256 tokenId, uint256 reserveUsdc, bytes32 salt)
        internal
        view
        returns (LabxRaffleHouse.CreateRaffleParams memory params)
    {
        params = LabxRaffleHouse.CreateRaffleParams({
            nft: address(nft),
            tokenId: tokenId,
            amount: 1,
            standard: LabxRaffleHouse.NftStandard.ERC721,
            seller: seller,
            opensAt: uint64(_now()),
            endsAt: uint64(_now() + 7 days),
            maxEntriesPerUser: 0,
            reserveCommitment: _reserveCommitment(reserveUsdc, salt),
            allowlistRoot: bytes32(0),
            allowlistBonusEntries: 0,
            freeEntryEnabled: true,
            metadataUri: "ipfs://labx/raffle"
        });
    }

    /// @notice Mints `tokenId` to the seller, approves the raffle house and lists it via the curator.
    function _createRaffle(uint256 tokenId, uint256 reserveUsdc, bytes32 salt) internal returns (uint256 raffleId) {
        return _createRaffle(_defaultRaffleParamsWithMint(tokenId, reserveUsdc, salt));
    }

    function _defaultRaffleParamsWithMint(uint256 tokenId, uint256 reserveUsdc, bytes32 salt)
        internal
        returns (LabxRaffleHouse.CreateRaffleParams memory params)
    {
        nft.mint(seller, tokenId);
        vm.prank(seller);
        nft.setApprovalForAll(address(raffleHouse), true);
        params = _defaultRaffleParams(tokenId, reserveUsdc, salt);
    }

    function _createRaffle(LabxRaffleHouse.CreateRaffleParams memory params) internal returns (uint256 raffleId) {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory signature = _signListing(params, deadline);
        vm.prank(curator);
        raffleId = raffleHouse.createRaffle(params, deadline, signature);
    }

    function _signListing(LabxRaffleHouse.CreateRaffleParams memory params, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "ListRaffle(address seller,address nft,uint256 tokenId,uint96 amount,uint8 standard,uint64 opensAt,uint64 endsAt,bytes32 reserveCommitment,uint256 nonce,uint64 deadline)"
                ),
                params.seller,
                params.nft,
                params.tokenId,
                params.amount,
                uint8(params.standard),
                params.opensAt,
                params.endsAt,
                params.reserveCommitment,
                raffleHouse.listingNonce(params.seller),
                deadline
            )
        );
        return _sign(sellerKey, raffleHouse.domainSeparator(), structHash);
    }

    function _signFreeEntry(address user, uint256 raffleId, bytes32 nonce, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("FreeEntry(address user,uint256 raffleId,bytes32 nonce,uint64 deadline)"),
                user,
                raffleId,
                nonce,
                deadline
            )
        );
        return _sign(attestorKey, amoe.domainSeparator(), structHash);
    }

    function _signCheckIn(address user, uint32 pointsAwarded, bytes32 nonce, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CheckIn(address user,uint32 points,bytes32 nonce,uint64 deadline)"),
                user,
                pointsAwarded,
                nonce,
                deadline
            )
        );
        return _sign(attestorKey, points.domainSeparator(), structHash);
    }

    function _signCountry(address user, bytes2 country, uint64 issuedAt, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CountryAttestation(address user,bytes2 country,uint64 issuedAt,uint64 deadline)"),
                user,
                country,
                issuedAt,
                deadline
            )
        );
        return _sign(attestorKey, jurisdiction.domainSeparator(), structHash);
    }

    function _sign(uint256 key, bytes32 domain, bytes32 structHash) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _allowlistLeaf(address account) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account))));
    }

    /// @notice Two-leaf Merkle root using OpenZeppelin's sorted-pair convention.
    function _twoLeafRoot(address a, address b) internal pure returns (bytes32 root, bytes32[] memory proofForA) {
        bytes32 leafA = _allowlistLeaf(a);
        bytes32 leafB = _allowlistLeaf(b);
        root = leafA < leafB ? keccak256(abi.encodePacked(leafA, leafB)) : keccak256(abi.encodePacked(leafB, leafA));
        proofForA = new bytes32[](1);
        proofForA[0] = leafB;
    }
}
