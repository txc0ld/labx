// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IVRFCoordinatorV2Plus} from "../../src/vendor/chainlink/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "../../src/vendor/chainlink/VRFV2PlusClient.sol";

interface IRawFulfil {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice Test double for the Chainlink VRF v2.5 coordinator: records requests and lets a test drive
///         the callback with a chosen random word.
contract MockVRFCoordinatorV2Plus is IVRFCoordinatorV2Plus {
    struct Request {
        address consumer;
        bytes32 keyHash;
        uint256 subId;
        uint32 numWords;
        bool nativePayment;
        bool fulfilled;
    }

    uint256 public nextRequestId = 1;
    mapping(uint256 requestId => Request) public requests;

    event RandomWordsRequested(uint256 requestId, address consumer, uint32 numWords);

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
        bool nativePayment;
        if (req.extraArgs.length >= 36) {
            (nativePayment) = abi.decode(req.extraArgs[4:], (bool));
        }
        requests[requestId] = Request({
            consumer: msg.sender,
            keyHash: req.keyHash,
            subId: req.subId,
            numWords: req.numWords,
            nativePayment: nativePayment,
            fulfilled: false
        });
        emit RandomWordsRequested(requestId, msg.sender, req.numWords);
    }

    function fulfill(uint256 requestId, uint256 randomWord) external {
        uint256[] memory words = new uint256[](1);
        words[0] = randomWord;
        fulfillWithWords(requestId, words);
    }

    function fulfillWithWords(uint256 requestId, uint256[] memory words) public {
        Request storage request = requests[requestId];
        require(request.consumer != address(0), "unknown request");
        require(!request.fulfilled, "already fulfilled");
        request.fulfilled = true;
        IRawFulfil(request.consumer).rawFulfillRandomWords(requestId, words);
    }

    function getSubscription(uint256)
        external
        pure
        returns (uint96, uint96, uint64, address, address[] memory consumers)
    {
        return (0, 0, 0, address(0), consumers);
    }
}
