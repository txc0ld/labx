// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";

/// @title CreateRaffle
/// @notice Lists a raffle from the command line, for Sepolia testing and emergency operations.
///
/// @dev The reserve is supplied as a commitment only. Compute it off-chain with the same encoding the
///      contract uses, `keccak256(abi.encode(uint256 reserveUsdc, bytes32 salt))`:
///
///        cast keccak $(cast abi-encode 'f(uint256,bytes32)' 300000000 $SALT)
///
///      The salt must be 32 bytes from a CSPRNG (`openssl rand -hex 32`). A guessable salt makes the
///      commitment brute-forceable, which would defeat the whole point of hiding the reserve.
///
///      Required environment:
///        LABX_RAFFLE_HOUSE, LABX_NFT, LABX_TOKEN_ID, LABX_SELLER, LABX_RESERVE_COMMITMENT
///      Optional:
///        LABX_ENDS_IN (seconds, default 7 days), LABX_MAX_ENTRIES_PER_USER, LABX_ALLOWLIST_ROOT,
///        LABX_ALLOWLIST_BONUS, LABX_FREE_ENTRY (default true), LABX_METADATA_URI,
///        LABX_SELLER_SIGNATURE (hex; required when the curator lists on a seller's behalf)
contract CreateRaffle is Script {
    function run() external returns (uint256 raffleId) {
        LabxRaffleHouse raffleHouse = LabxRaffleHouse(vm.envAddress("LABX_RAFFLE_HOUSE"));

        LabxRaffleHouse.CreateRaffleParams memory params = LabxRaffleHouse.CreateRaffleParams({
            nft: vm.envAddress("LABX_NFT"),
            tokenId: vm.envUint("LABX_TOKEN_ID"),
            amount: 1,
            standard: LabxRaffleHouse.NftStandard.ERC721,
            seller: vm.envAddress("LABX_SELLER"),
            opensAt: 0, // 0 means "open now"
            endsAt: uint64(block.timestamp + vm.envOr("LABX_ENDS_IN", uint256(7 days))),
            maxEntriesPerUser: uint32(vm.envOr("LABX_MAX_ENTRIES_PER_USER", uint256(0))),
            reserveCommitment: vm.envBytes32("LABX_RESERVE_COMMITMENT"),
            allowlistRoot: vm.envOr("LABX_ALLOWLIST_ROOT", bytes32(0)),
            allowlistBonusEntries: uint32(vm.envOr("LABX_ALLOWLIST_BONUS", uint256(0))),
            freeEntryEnabled: vm.envOr("LABX_FREE_ENTRY", true),
            metadataUri: vm.envOr("LABX_METADATA_URI", string(""))
        });

        uint64 signatureDeadline = uint64(block.timestamp + 1 hours);
        bytes memory sellerSignature = vm.envOr("LABX_SELLER_SIGNATURE", bytes(""));

        vm.broadcast();
        raffleId = raffleHouse.createRaffle(params, signatureDeadline, sellerSignature);

        console2.log("raffle", raffleId, "created; prize escrowed from", params.seller);
        console2.log("reserve commitment:");
        console2.logBytes32(params.reserveCommitment);
    }
}
