// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockFeed, MockWETH, MockRouter, MockVRF} from "../test/mocks/Mocks.sol";

/// @notice Local Anvil deployment. Refuses Ethereum mainnet.
contract DeployLocal is Script {
    function run() external {
        if (block.chainid == 1) revert("LABx: mainnet disabled");
        if (block.chainid != 31337) revert("LABx: local script is Anvil only");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address safe = vm.envOr("SAFE_ADDRESS", deployer);
        address amoe = vm.envOr("AMOE_SIGNER", deployer);
        bytes32 terms = vm.envOr("TERMS_HASH", keccak256("labx-local-terms"));

        vm.startBroadcast(pk);
        MockERC20 usdc = new MockERC20("USD Coin", "USDC", 6);
        MockWETH weth = new MockWETH();
        MockRouter router = new MockRouter(weth, usdc);
        MockFeed feed = new MockFeed();
        MockVRF vrf = new MockVRF();
        LabxRaffle labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: safe,
                usdc: address(usdc),
                router: address(router),
                weth: address(weth),
                ethUsdFeed: address(feed),
                poolFee: 3000,
                vrfCoordinator: address(vrf),
                keyHash: keccak256("local"),
                subscriptionId: 1,
                amoeSigner: amoe,
                termsHash: terms,
                callbackGasLimit: 500_000,
                requestConfirmations: 3,
                amoeCap: 0
            })
        );
        if (safe != deployer) labx.transferOwnership(safe);
        usdc.mint(deployer, 1_000_000e6);
        vm.stopBroadcast();

        console2.log("LabxRaffle", address(labx));
        console2.log("USDC", address(usdc));
        console2.log("VRF", address(vrf));
        console2.log("termsHash");
        console2.logBytes32(terms);
    }
}
