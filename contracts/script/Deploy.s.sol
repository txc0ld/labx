// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {LabxTerms} from "../src/LabxTerms.sol";
import {LabxJurisdictionRegistry} from "../src/LabxJurisdictionRegistry.sol";
import {LabxMembership} from "../src/LabxMembership.sol";
import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";
import {LabxAmoeGateway} from "../src/LabxAmoeGateway.sol";
import {LabxPoints} from "../src/LabxPoints.sol";
import {LabxDiscountMarketplace} from "../src/LabxDiscountMarketplace.sol";
import {LabxUniswapV3SwapAdapter} from "../src/LabxUniswapV3SwapAdapter.sol";
import {LabxVRFConsumerBase} from "../src/base/LabxVRFConsumerBase.sol";

import {LabxConfig} from "./LabxConfig.sol";

/// @title Deploy
/// @notice Deploys the LABx stack and hands every privileged role to the Fantom Labs Safe multisig.
///
/// @dev Required environment:
///        LABX_SAFE                Safe multisig address. Receives `DEFAULT_ADMIN_ROLE` everywhere.
///        LABX_TREASURY            Treasury that receives fees and expired entry value (normally the Safe).
///        LABX_VRF_SUBSCRIPTION_ID Chainlink VRF v2.5 subscription that funds the draws.
///      Optional:
///        LABX_OPERATIONS          Operations relayer (closing raffles, reveals, prize delivery).
///        LABX_CURATOR             Curator that lists raffles and perks.
///        LABX_ATTESTOR            Attestor key used by the LABx API for captcha / check-in / geo proofs.
///        LABX_SEED_PACKS          Set to "false" to skip creating the launch membership packs.
///
///      This script refuses to run on Ethereum mainnet. Mainnet is explicitly out of scope; see
///      `docs/launch-checklist.md` for what has to be true before that changes.
contract Deploy is Script {
    struct Deployment {
        LabxTerms terms;
        LabxJurisdictionRegistry jurisdiction;
        LabxMembership membership;
        LabxUniswapV3SwapAdapter swapAdapter;
        LabxRaffleHouse raffleHouse;
        LabxAmoeGateway amoe;
        LabxPoints points;
        LabxDiscountMarketplace marketplace;
    }

    function run() external returns (Deployment memory deployment) {
        require(block.chainid != LabxConfig.MAINNET, "Deploy: mainnet is out of scope for this repository");
        LabxConfig.Network memory network = LabxConfig.network(block.chainid);

        address safe = vm.envAddress("LABX_SAFE");
        address treasury = vm.envAddress("LABX_TREASURY");
        uint256 subscriptionId = vm.envUint("LABX_VRF_SUBSCRIPTION_ID");
        address operations = vm.envOr("LABX_OPERATIONS", safe);
        address curator = vm.envOr("LABX_CURATOR", safe);
        address attestor = vm.envOr("LABX_ATTESTOR", safe);
        bool seedPacks = vm.envOr("LABX_SEED_PACKS", true);

        // The deployer briefly holds admin so it can wire roles in one transaction batch, then renounces.
        address deployer = msg.sender;

        vm.startBroadcast();

        deployment.terms = new LabxTerms(deployer);
        deployment.jurisdiction = new LabxJurisdictionRegistry(deployer);
        deployment.membership = new LabxMembership(deployer, network.usdc, treasury);
        deployment.swapAdapter = new LabxUniswapV3SwapAdapter(
            deployer, network.uniswapRouter, network.usdc, network.weth, network.ethUsdFeed
        );
        deployment.raffleHouse = new LabxRaffleHouse(
            deployer,
            network.usdc,
            address(deployment.membership),
            treasury,
            network.vrfCoordinator,
            LabxVRFConsumerBase.VrfConfig({
                keyHash: network.vrfKeyHash,
                subscriptionId: subscriptionId,
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                nativePayment: false
            })
        );
        deployment.amoe = new LabxAmoeGateway(deployer, address(deployment.raffleHouse));
        deployment.points = new LabxPoints(deployer, address(deployment.membership));
        deployment.marketplace = new LabxDiscountMarketplace(deployer, address(deployment.membership));

        _publishLegalDocuments(deployment.terms);
        _wire(deployment, network);
        if (seedPacks) _seedPacks(deployment.membership);
        _grantOperationalRoles(deployment, operations, curator, attestor);
        _handOverToSafe(deployment, safe, deployer);

        vm.stopBroadcast();

        _log(deployment, network, safe, treasury);
    }

    function _publishLegalDocuments(LabxTerms terms) private {
        // Placeholder content hashes. `script/PublishTerms.s.sol` republishes with the real document
        // hashes before launch; every member then re-accepts the new version.
        terms.publish(terms.TERMS_OF_USE(), "https://labx.art/legal/terms", keccak256("labx-terms-v1-placeholder"));
        terms.publish(
            terms.RAFFLE_RULES(), "https://labx.art/legal/raffle-rules", keccak256("labx-rules-v1-placeholder")
        );
        terms.publish(
            terms.PRIVACY_POLICY(), "https://labx.art/legal/privacy", keccak256("labx-privacy-v1-placeholder")
        );
        terms.publish(
            terms.ENTRY_EXPIRY_DISCLOSURE(),
            "https://labx.art/legal/entry-expiry",
            keccak256("labx-entry-expiry-v1-placeholder")
        );

        terms.setRequired(terms.TERMS_OF_USE(), true);
        terms.setRequired(terms.RAFFLE_RULES(), true);
        terms.setRequired(terms.ENTRY_EXPIRY_DISCLOSURE(), true);
    }

    function _wire(Deployment memory d, LabxConfig.Network memory network) private {
        d.swapAdapter.setPoolFee(network.uniswapPoolFee);

        d.membership.setTerms(address(d.terms));
        d.membership.setJurisdiction(address(d.jurisdiction));
        d.membership.setSwapAdapter(address(d.swapAdapter));

        d.raffleHouse.setTerms(address(d.terms));
        d.raffleHouse.setJurisdiction(address(d.jurisdiction));

        d.marketplace.setTerms(address(d.terms));

        // The raffle house is the only contract allowed to spend a member's entries or buy on their behalf.
        d.membership.grantRole(d.membership.ENTRY_SPENDER_ROLE(), address(d.raffleHouse));
        d.membership.grantRole(d.membership.PURCHASE_ROUTER_ROLE(), address(d.raffleHouse));
        // Points mint free entries into the platform-wide balance; the AMOE gateway adds them to a raffle.
        d.membership.grantRole(d.membership.ENTRY_ISSUER_ROLE(), address(d.points));
        d.raffleHouse.grantRole(d.raffleHouse.ENTRY_ISSUER_ROLE(), address(d.amoe));
    }

    function _seedPacks(LabxMembership membership) private {
        LabxConfig.Pack[] memory packs = LabxConfig.launchPacks();
        for (uint256 i; i < packs.length; ++i) {
            membership.addTier(packs[i].name, packs[i].priceUsdc, packs[i].entries, packs[i].discountBps, packs[i].rank);
        }
    }

    function _grantOperationalRoles(Deployment memory d, address operations, address curator, address attestor)
        private
    {
        d.membership.grantRole(d.membership.OPERATIONS_ROLE(), operations);
        d.raffleHouse.grantRole(d.raffleHouse.OPERATIONS_ROLE(), operations);
        d.raffleHouse.grantRole(d.raffleHouse.CURATOR_ROLE(), curator);
        d.points.grantRole(d.points.OPERATIONS_ROLE(), operations);
        d.marketplace.grantRole(d.marketplace.CURATOR_ROLE(), curator);

        d.amoe.grantRole(d.amoe.ATTESTOR_ROLE(), attestor);
        d.points.grantRole(d.points.ATTESTOR_ROLE(), attestor);
        d.jurisdiction.grantRole(d.jurisdiction.ATTESTOR_ROLE(), attestor);
    }

    function _handOverToSafe(Deployment memory d, address safe, address deployer) private {
        bytes32 admin = 0x00; // DEFAULT_ADMIN_ROLE

        d.terms.grantRole(admin, safe);
        d.jurisdiction.grantRole(admin, safe);
        d.membership.grantRole(admin, safe);
        d.swapAdapter.grantRole(admin, safe);
        d.raffleHouse.grantRole(admin, safe);
        d.amoe.grantRole(admin, safe);
        d.points.grantRole(admin, safe);
        d.marketplace.grantRole(admin, safe);

        if (deployer == safe) return;

        d.terms.renounceRole(admin, deployer);
        d.jurisdiction.renounceRole(admin, deployer);
        d.membership.renounceRole(admin, deployer);
        d.swapAdapter.renounceRole(admin, deployer);
        d.raffleHouse.renounceRole(admin, deployer);
        d.amoe.renounceRole(admin, deployer);
        d.points.renounceRole(admin, deployer);
        d.marketplace.renounceRole(admin, deployer);
    }

    function _log(Deployment memory d, LabxConfig.Network memory network, address safe, address treasury)
        private
        pure
    {
        console2.log("LABx deployed on", network.name);
        console2.log("  admin safe           ", safe);
        console2.log("  treasury             ", treasury);
        console2.log("  LabxTerms            ", address(d.terms));
        console2.log("  LabxJurisdiction     ", address(d.jurisdiction));
        console2.log("  LabxMembership       ", address(d.membership));
        console2.log("  LabxSwapAdapter      ", address(d.swapAdapter));
        console2.log("  LabxRaffleHouse      ", address(d.raffleHouse));
        console2.log("  LabxAmoeGateway      ", address(d.amoe));
        console2.log("  LabxPoints           ", address(d.points));
        console2.log("  LabxMarketplace      ", address(d.marketplace));
        console2.log("");
        console2.log("Next: add LabxRaffleHouse as a consumer on the VRF subscription, then");
        console2.log("populate apps/web/.env with these addresses. See docs/deployment.md.");
    }
}
