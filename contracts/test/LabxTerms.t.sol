// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LabxTestBase} from "./helpers/LabxTestBase.sol";
import {LabxTerms} from "../src/LabxTerms.sol";

contract LabxTermsTest is LabxTestBase {
    function test_publishingBumpsTheVersionAndStoresTheContentHash() public {
        bytes32 key = terms.PRIVACY_POLICY();

        vm.prank(safe);
        uint32 v1 = terms.publish(key, "https://labx.art/legal/privacy", keccak256("privacy-v1"));
        assertEq(v1, 1);

        vm.prank(safe);
        uint32 v2 = terms.publish(key, "https://labx.art/legal/privacy", keccak256("privacy-v2"));
        assertEq(v2, 2);
        assertEq(terms.currentVersion(key), 2);

        LabxTerms.Document memory doc = terms.document(key, 1);
        assertEq(doc.contentHash, keccak256("privacy-v1"), "superseded wording is still retrievable");
    }

    function test_acceptanceRecordsTheExactVersion() public {
        bytes32 key = terms.TERMS_OF_USE();
        assertEq(terms.acceptedVersion(alice, key), 1);
        assertEq(terms.acceptedAt(alice, key), _now());
        assertTrue(terms.hasAcceptedAll(alice));
    }

    function test_acceptingAStaleVersionIsRejected() public {
        bytes32 key = terms.TERMS_OF_USE();
        vm.prank(safe);
        terms.publish(key, "https://labx.art/legal/terms", keccak256("terms-v2"));

        bytes32[] memory keys = new bytes32[](1);
        uint32[] memory versions = new uint32[](1);
        keys[0] = key;
        versions[0] = 1;

        vm.expectRevert(abi.encodeWithSelector(LabxTerms.StaleVersion.selector, key, 1, 2));
        vm.prank(alice);
        terms.accept(keys, versions);
    }

    function test_pendingKeysListsWhatIsOutstanding() public {
        bytes32 key = terms.RAFFLE_RULES();
        vm.prank(safe);
        terms.publish(key, "https://labx.art/legal/raffle-rules", keccak256("rules-v2"));

        bytes32[] memory pending = terms.pendingKeys(alice);
        assertEq(pending.length, 1);
        assertEq(pending[0], key);
    }

    function test_relayedAcceptanceLetsLabxPayTheGas() public {
        address member = vm.addr(0xC0FFEE);
        bytes32[] memory keys = new bytes32[](2);
        uint32[] memory versions = new uint32[](2);
        keys[0] = terms.TERMS_OF_USE();
        keys[1] = terms.RAFFLE_RULES();
        versions[0] = terms.currentVersion(keys[0]);
        versions[1] = terms.currentVersion(keys[1]);

        uint64 deadline = uint64(_now() + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AcceptTerms(address user,bytes32[] keys,uint32[] versions,uint256 nonce,uint64 deadline)"),
                member,
                keccak256(abi.encodePacked(keys)),
                keccak256(abi.encodePacked(uint256(versions[0]), uint256(versions[1]))),
                terms.acceptanceNonce(member),
                deadline
            )
        );
        bytes memory signature = _sign(0xC0FFEE, terms.domainSeparator(), structHash);

        vm.prank(operator); // relayer, not the member
        terms.acceptWithSignature(member, keys, versions, deadline, signature);

        assertTrue(terms.hasAcceptedAll(member));
        assertEq(terms.acceptanceNonce(member), 1, "the nonce stops the signature being replayed");
    }

    function test_relayedAcceptanceRejectsAForeignSignature() public {
        address member = vm.addr(0xC0FFEE);
        bytes32[] memory keys = new bytes32[](1);
        uint32[] memory versions = new uint32[](1);
        keys[0] = terms.TERMS_OF_USE();
        versions[0] = 1;

        uint64 deadline = uint64(_now() + 1 hours);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("AcceptTerms(address user,bytes32[] keys,uint32[] versions,uint256 nonce,uint64 deadline)"),
                member,
                keccak256(abi.encodePacked(keys)),
                keccak256(abi.encodePacked(uint256(1))),
                uint256(0),
                deadline
            )
        );
        bytes memory signature = _sign(0xBADBAD, terms.domainSeparator(), structHash);

        vm.expectRevert(LabxTerms.InvalidSignature.selector);
        terms.acceptWithSignature(member, keys, versions, deadline, signature);
    }

    function test_requiringAnUnpublishedDocumentIsRejected() public {
        vm.expectRevert(abi.encodeWithSelector(LabxTerms.UnknownDocument.selector, keccak256("NOPE")));
        vm.prank(safe);
        terms.setRequired(keccak256("NOPE"), true);
    }

    function test_removingARequirementShrinksTheSet() public {
        bytes32 key = terms.RAFFLE_RULES();
        vm.prank(safe);
        terms.setRequired(key, false);

        assertEq(terms.requiredKeys().length, 1);
        assertTrue(terms.hasAcceptedAll(makeAddr("nobody")) == false);

        bytes32 remaining = terms.requiredKeys()[0];
        assertEq(remaining, terms.TERMS_OF_USE());
    }

    function test_onlyAdminCanPublish() public {
        vm.expectRevert();
        vm.prank(alice);
        terms.publish(keccak256("ROGUE"), "https://evil.example", keccak256("x"));
    }
}
