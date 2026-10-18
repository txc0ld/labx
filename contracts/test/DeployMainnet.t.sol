// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC721} from "./mocks/Mocks.sol";
import {DeployMainnet} from "../script/DeployMainnet.s.sol";

interface ICoordinatorView {
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] memory consumers);
    function acceptSubscriptionOwnerTransfer(uint256 subId) external;
}

interface IUsdc {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract DeployMainnetHarness is DeployMainnet {
    function validateSafe(address safe) external view {
        _validateSafe(safe);
    }

    function validateCallbackGas(uint256 callbackGas) external pure {
        _validateCallbackGas(callbackGas);
    }
}

/// @notice Refusals that happen before anything is broadcast. They need no fork, and read no environment variables,
///         which other test contracts running in parallel also set.
contract DeployMainnetRefusalTest is Test {
    address internal safe = makeAddr("mainnet-safe-fixture");
    DeployMainnetHarness internal script = new DeployMainnetHarness();

    function test_refusesEveryChainButMainnet() public {
        vm.chainId(11155111);
        vm.expectRevert("LABx: mainnet only.");
        script.run();
    }

    function test_refusesASafeWithoutCodeOrBelowTwoSignatures() public {
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.SafeNotDeployed.selector, safe));
        script.validateSafe(safe);
        vm.etch(safe, hex"00");
        vm.mockCall(safe, abi.encodeWithSignature("getThreshold()"), abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.SafeThresholdTooLow.selector, safe, uint256(1)));
        script.validateSafe(safe);
        vm.mockCall(safe, abi.encodeWithSignature("getThreshold()"), abi.encode(uint256(2)));
        script.validateSafe(safe);
    }

    function test_refusesACallbackGasLimitTheContractWouldReject() public {
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.CallbackGasOutOfRange.selector, uint256(199_999)));
        script.validateCallbackGas(199_999);
        vm.expectRevert(abi.encodeWithSelector(DeployMainnet.CallbackGasOutOfRange.selector, uint256(2_500_001)));
        script.validateCallbackGas(2_500_001);
        script.validateCallbackGas(250_000);
    }
}

/// @notice The full mainnet deployment and one raffle lifecycle against real chain-1 state: Circle USDC, the Chainlink
///         VRF v2.5 coordinator and the LABx Safe. Opt in with MAINNET_FORK_RPC_URL; skipped otherwise.
contract DeployMainnetForkTest is Test {
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    address internal constant SAFE = 0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1;
    uint256 internal constant TEST_KEY = 0xB0B;
    uint256 internal constant CALLBACK_GAS = 250_000;
    uint256 internal constant FUND = 0.2 ether;

    LabxRaffle internal labx;
    uint256 internal subId;
    address internal deployer = vm.addr(TEST_KEY);
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    function setUp() public {
        string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        vm.deal(deployer, 1 ether);
        vm.setEnv("SAFE_ADDRESS", vm.toString(SAFE));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(TEST_KEY));
        vm.setEnv("TERMS_HASH", vm.toString(keccak256("labx mainnet rehearsal terms")));
        vm.setEnv("VRF_CALLBACK_GAS_LIMIT", vm.toString(CALLBACK_GAS));
        vm.setEnv("VRF_FUND_WEI", vm.toString(FUND));
        (labx, subId) = new DeployMainnet().run();
    }

    function test_deploysPinnedToMainnetAndHandsEverythingToTheSafe() public {
        assertEq(address(labx.usdc()), USDC);
        assertEq(labx.vrfCoordinator(), COORDINATOR);
        assertEq(labx.subscriptionId(), subId);
        assertEq(labx.callbackGasLimit(), CALLBACK_GAS);
        assertTrue(labx.nativePayment());
        assertFalse(labx.ethPathEnabled());
        assertEq(labx.treasury(), SAFE);
        assertEq(labx.owner(), deployer);
        assertEq(labx.pendingOwner(), SAFE);
        (, uint96 nativeBalance,, address subOwner, address[] memory consumers) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(nativeBalance, FUND);
        assertEq(subOwner, deployer);
        assertEq(consumers.length, 1);
        assertEq(consumers[0], address(labx));

        vm.startPrank(SAFE);
        labx.acceptOwnership();
        ICoordinatorView(COORDINATOR).acceptSubscriptionOwnerTransfer(subId);
        vm.stopPrank();
        assertEq(labx.owner(), SAFE);
        (,,, subOwner,) = ICoordinatorView(COORDINATOR).getSubscription(subId);
        assertEq(subOwner, SAFE);
    }

    function test_runsOneRaffleThroughTheRealCoordinatorAndUsdc() public {
        vm.startPrank(SAFE);
        labx.acceptOwnership();
        ICoordinatorView(COORDINATOR).acceptSubscriptionOwnerTransfer(subId);
        vm.stopPrank();

        MockERC721 nft = new MockERC721();
        nft.mint(seller, 1);
        bytes32 nonce = bytes32(uint256(7));
        bytes32 publicHash = keccak256("public-summary");
        bytes32 privateHash = keccak256("private-commitment");
        bytes32 salt = bytes32(uint256(9));
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig({name: "Entry", priceUsdc: 25e6, bonusEntries: 1, maxSupply: 100});

        vm.startPrank(seller);
        uint256 id = labx.createRaffle(
            address(nft), 1, uint64(block.timestamp + 1 days), nonce,
            labx.hashCommitment(nonce, address(nft), 1, publicHash, privateHash, salt), "Mainnet rehearsal", packs
        );
        nft.approve(address(labx), 1);
        labx.escrow(id);
        vm.stopPrank();
        bytes32 digest = labx.draftReviewHash(id);
        vm.prank(SAFE);
        labx.approveRaffle(id, digest);
        vm.prank(seller);
        labx.open(id);

        deal(USDC, buyer, 100e6);
        vm.startPrank(buyer);
        IUsdc(USDC).approve(address(labx), type(uint256).max);
        labx.buyPack(id, 0, 1, labx.termsHash());
        vm.stopPrank();
        assertEq(IUsdc(USDC).balanceOf(buyer), 100e6 - 27_500_000);

        vm.warp(block.timestamp + 1 days);
        labx.close(id);
        labx.snapshot(id, 100);
        labx.requestRandomness(id);
        uint256 requestId = labx.getRaffle(id).vrfRequestId;
        assertGt(requestId, 0);

        uint256[] memory words = new uint256[](1);
        words[0] = 42;
        uint256 before = gasleft();
        vm.prank(COORDINATOR);
        labx.rawFulfillRandomWords(requestId, words);
        uint256 callbackGas = before - gasleft();
        emit log_named_uint("callback gas used", callbackGas);
        assertLt(callbackGas, CALLBACK_GAS / 2);
        assertEq(labx.getRaffle(id).winner, buyer);

        vm.prank(seller);
        labx.reveal(id, publicHash, privateHash, salt);
        labx.settle(id);
        vm.prank(buyer);
        labx.claimPrize(id);
        vm.prank(seller);
        labx.claimProceeds(id);
        uint256 treasuryBefore = IUsdc(USDC).balanceOf(SAFE);
        labx.claimFee(id);
        assertEq(nft.ownerOf(1), buyer);
        assertEq(IUsdc(USDC).balanceOf(seller), 24_500_000);
        assertEq(IUsdc(USDC).balanceOf(SAFE) - treasuryBefore, 3_000_000);
    }
}
