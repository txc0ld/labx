// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";

abstract contract AdmissionFixture is Test {
    function _approveAdmission(LabxRaffle target, uint256 id) internal {
        (VmSafe.CallerMode mode, address sender, address origin) = vm.readCallers();
        vm.stopPrank();
        bytes32 digest = target.draftReviewHash(id);
        address approver = target.owner();
        vm.prank(approver);
        target.approveRaffle(id, digest);
        if (mode == VmSafe.CallerMode.RecurrentPrank) vm.startPrank(sender, origin);
        else if (mode == VmSafe.CallerMode.Prank) vm.prank(sender, origin);
    }

    function _processingFee(uint256 principal) internal pure returns (uint256) {
        uint256 proportional = principal * 200 / 10_000;
        return proportional < 2_500_000 ? 2_500_000 : proportional;
    }
}
