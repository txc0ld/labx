// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {LabxRaffleHouse} from "../src/LabxRaffleHouse.sol";

/// @title SettleRaffle
/// @notice Runs the go/no-go step after a raffle closes: reveal the reserve and either draw or refund.
///
/// @dev The backend normally does this automatically. This script is the manual fallback and the Sepolia
///      rehearsal path. It never decides the outcome itself: the contract checks `pot >= reserve` against
///      the commitment made at listing time, so a wrong reveal simply reverts.
///
///      Required environment:
///        LABX_RAFFLE_HOUSE, LABX_RAFFLE_ID, LABX_RESERVE, LABX_RESERVE_SALT
contract SettleRaffle is Script {
    function run() external {
        LabxRaffleHouse raffleHouse = LabxRaffleHouse(vm.envAddress("LABX_RAFFLE_HOUSE"));
        uint256 raffleId = vm.envUint("LABX_RAFFLE_ID");
        uint256 reserve = vm.envUint("LABX_RESERVE");
        bytes32 salt = vm.envBytes32("LABX_RESERVE_SALT");

        LabxRaffleHouse.Raffle memory raffle = raffleHouse.raffles(raffleId);
        require(
            raffle.status == LabxRaffleHouse.RaffleStatus.Open
                || raffle.status == LabxRaffleHouse.RaffleStatus.Closed,
            "SettleRaffle: raffle is past the reveal step"
        );
        require(
            raffleHouse.reserveCommitmentFor(reserve, salt) == raffle.reserveCommitment,
            "SettleRaffle: reserve and salt do not match the on-chain commitment"
        );

        if (raffle.status == LabxRaffleHouse.RaffleStatus.Open) {
            vm.broadcast();
            raffleHouse.closeEntries(raffleId);
            raffle = raffleHouse.raffles(raffleId);
        }

        if (raffle.pot >= reserve && raffle.totalEntries != 0) {
            vm.broadcast();
            uint256 requestId = raffleHouse.revealAndDraw(raffleId, reserve, salt);
            console2.log("reserve met; VRF request", requestId);
        } else {
            vm.broadcast();
            raffleHouse.revealAndRefund(raffleId, reserve, salt);
            console2.log("reserve not met; prize returned and entrants may pull their entries back");
        }
    }
}
