// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeploySepolia} from "../script/DeploySepolia.s.sol";

contract DeploySepoliaHarness is DeploySepolia {
    function validateSafe(address safe) external view {
        _validateSafe(safe);
    }
}

contract DeploySepoliaTest is Test {
    function test_safeGuardRejectsAddressesWithoutDeployedCode() public {
        DeploySepoliaHarness script = new DeploySepoliaHarness();
        address eoa = makeAddr("undeployed-safe");
        vm.expectRevert(abi.encodeWithSelector(DeploySepolia.SafeNotDeployed.selector, eoa));
        script.validateSafe(eoa);
        vm.expectRevert(abi.encodeWithSelector(DeploySepolia.SafeNotDeployed.selector, address(0)));
        script.validateSafe(address(0));
    }

    function test_safeGuardAllowsDeployedCodeWithoutClaimingSafeVerification() public {
        DeploySepoliaHarness script = new DeploySepoliaHarness();
        // The guard prevents absent code, not a malicious implementation. Operator
        // verification of Safe implementation, owners and threshold remains required.
        script.validateSafe(address(this));
    }
}
