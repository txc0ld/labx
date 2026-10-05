// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxJurisdictionRegistry} from "../src/LabxJurisdictionRegistry.sol";

/// @notice Geo gating ships switched off. These tests pin that default down, then exercise the gates so
///         enabling them is a configuration change rather than a code change.
contract LabxJurisdictionRegistryTest is LabxTestBase {
    bytes2 internal constant AU = "AU";
    bytes2 internal constant US = "US";

    function test_gatesAreOffByDefaultSoEveryoneIsAllowed() public {
        address anyone = makeAddr("anyone-at-all");
        assertFalse(jurisdiction.gatesEnabled());
        assertTrue(jurisdiction.isAllowed(alice));
        assertTrue(jurisdiction.isAllowed(anyone));
        jurisdiction.requireAllowed(anyone);
    }

    function test_purchasesWorkWithNoAttestationWhileGatesAreOff() public {
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
        assertEq(membership.entriesAvailable(alice), 5);
    }

    function test_enablingGatesRequiresAFreshAttestation() public {
        vm.prank(safe);
        jurisdiction.setGatesEnabled(true);

        assertFalse(jurisdiction.isAllowed(alice));
        vm.expectRevert(abi.encodeWithSelector(LabxJurisdictionRegistry.NoAttestation.selector, alice));
        jurisdiction.requireAllowed(alice);

        vm.expectRevert(abi.encodeWithSelector(LabxJurisdictionRegistry.NoAttestation.selector, alice));
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
    }

    function test_attestedCountryPassesADenyList() public {
        vm.startPrank(safe);
        jurisdiction.setGatesEnabled(true);
        jurisdiction.setCountryBlocked(US, true);
        vm.stopPrank();

        _attest(alice, AU);
        assertTrue(jurisdiction.isAllowed(alice));

        _attest(bob, US);
        assertFalse(jurisdiction.isAllowed(bob));
        vm.expectRevert(abi.encodeWithSelector(LabxJurisdictionRegistry.CountryNotPermitted.selector, US));
        jurisdiction.requireAllowed(bob);
    }

    function test_allowlistModeOnlyPermitsListedCountries() public {
        vm.startPrank(safe);
        jurisdiction.setGatesEnabled(true);
        jurisdiction.setAllowlistMode(true);
        jurisdiction.setCountryAllowed(AU, true);
        vm.stopPrank();

        _attest(alice, AU);
        _attest(bob, US);
        assertTrue(jurisdiction.isAllowed(alice));
        assertFalse(jurisdiction.isAllowed(bob));
    }

    function test_attestationsExpire() public {
        vm.prank(safe);
        jurisdiction.setGatesEnabled(true);
        _attest(alice, AU);
        assertTrue(jurisdiction.isAllowed(alice));

        vm.warp(_now() + 181 days);
        assertFalse(jurisdiction.isAllowed(alice));
    }

    function test_attestationNeedsTheAttestorRole() public {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("CountryAttestation(address user,bytes2 country,uint64 issuedAt,uint64 deadline)"),
                alice,
                AU,
                uint64(_now()),
                deadline
            )
        );
        bytes memory forged = _sign(0xBAD, jurisdiction.domainSeparator(), structHash);

        vm.expectRevert(LabxJurisdictionRegistry.InvalidAttestor.selector);
        jurisdiction.attest(alice, AU, uint64(_now()), deadline, forged);
    }

    function test_addressBlockAppliesEvenWithGatesOff() public {
        vm.prank(safe);
        jurisdiction.setAddressBlocked(alice, true);

        assertFalse(jurisdiction.gatesEnabled());
        assertFalse(jurisdiction.isAllowed(alice));
        vm.expectRevert(abi.encodeWithSelector(LabxJurisdictionRegistry.Blocked.selector, alice));
        jurisdiction.requireAllowed(alice);

        vm.expectRevert(abi.encodeWithSelector(LabxJurisdictionRegistry.Blocked.selector, alice));
        vm.prank(alice);
        membership.purchaseWithUsdc(TIER_ENTRY);
    }

    function test_gatesCanRunInAdvisoryModeWithoutAttestations() public {
        vm.startPrank(safe);
        jurisdiction.setGatesEnabled(true);
        jurisdiction.setAttestationRequired(false);
        jurisdiction.setCountryBlocked(US, true);
        vm.stopPrank();

        assertTrue(jurisdiction.isAllowed(alice), "no attestation means no evidence of a blocked country");

        _attest(bob, US);
        assertFalse(jurisdiction.isAllowed(bob));
    }

    function test_togglesAreAdminOnly() public {
        vm.expectRevert();
        vm.prank(alice);
        jurisdiction.setGatesEnabled(true);
    }

    function _attest(address user, bytes2 country) internal {
        uint64 deadline = uint64(_now() + 1 hours);
        bytes memory sig = _signCountry(user, country, uint64(_now()), deadline);
        jurisdiction.attest(user, country, uint64(_now()), deadline, sig);
    }
}
