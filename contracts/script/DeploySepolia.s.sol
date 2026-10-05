// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {IVRFSubscriptionV2Plus} from "../src/interfaces/External.sol";

/// @notice Deploys LABx to Ethereum Sepolia and proposes Safe as owner.
///         Mainnet and every other chain id are refused.
contract DeploySepolia is Script {
    // Confirmed against Chainlink VRF v2.5 docs and Circle USDC (Sepolia), October 2026.
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant VRF_COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    bytes32 internal constant VRF_KEY_HASH = 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae;
    address internal constant LINK = 0x779877A7B0D9E8603169DdbD7836e478b4624789;
    address internal constant SWAP_ROUTER_02 = 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E;
    address internal constant WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    address internal constant ETH_USD_FEED = 0x694AA1769357215DE4FAC081bf1f309aDC325306;

    function run() external {
        if (block.chainid != 11155111) revert("LABx: Sepolia only. Mainnet is disabled.");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address safe = vm.envAddress("SAFE_ADDRESS");
        address amoe = vm.envAddress("AMOE_SIGNER");
        bytes32 terms = vm.envBytes32("TERMS_HASH");
        uint256 subId = vm.envUint("VRF_SUBSCRIPTION_ID");
        bool wireEth = vm.envOr("WIRE_ETH_PATH", false);

        vm.startBroadcast(pk);
        LabxRaffle labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: safe,
                usdc: USDC,
                router: wireEth ? SWAP_ROUTER_02 : address(0),
                weth: wireEth ? WETH : address(0),
                ethUsdFeed: wireEth ? ETH_USD_FEED : address(0),
                poolFee: uint24(vm.envOr("UNISWAP_POOL_FEE", uint256(3000))),
                vrfCoordinator: VRF_COORDINATOR,
                keyHash: VRF_KEY_HASH,
                subscriptionId: subId,
                amoeSigner: amoe,
                termsHash: terms,
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                amoeCap: 0
            })
        );
        labx.transferOwnership(safe);
        vm.stopBroadcast();

        console2.log("LabxRaffle", address(labx));
        console2.log("USDC", USDC);
        console2.log("LINK", LINK);
        console2.log("VRF coordinator", VRF_COORDINATOR);
        console2.log("Safe must acceptOwnership and addConsumer on the VRF subscription");
    }
}

/// @notice Safe (or the subscription owner) adds the raffle as a VRF consumer. Sepolia only.
contract AddVrfConsumer is Script {
    function run() external {
        if (block.chainid != 11155111) revert("LABx: Sepolia only. Mainnet is disabled.");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address coordinator = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
        uint256 subId = vm.envUint("VRF_SUBSCRIPTION_ID");
        address consumer = vm.envAddress("RAFFLE_ADDRESS");
        vm.startBroadcast(pk);
        IVRFSubscriptionV2Plus(coordinator).addConsumer(subId, consumer);
        vm.stopBroadcast();
    }
}
