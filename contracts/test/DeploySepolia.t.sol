// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AdmissionFixture} from "./AdmissionFixture.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockVRF} from "./mocks/Mocks.sol";
import {VRFV2PlusClient} from "../src/vendor/VRFV2PlusClient.sol";
import {DeploySepolia} from "../script/DeploySepolia.s.sol";

contract DeploySepoliaHarness is DeploySepolia {
    function validateSafe(address safe) external view {
        _validateSafe(safe);
    }
}

contract DeploySepoliaTest is AdmissionFixture {
    address internal constant USDC = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address internal constant COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    bytes32 internal constant KEY_HASH = 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae;
    bytes32 internal constant TERMS = keccak256("disposable deployment test terms");
    uint256 internal constant SUBSCRIPTION = 12345;
    // Public disposable fixture, never a funded or production identity.
    uint256 internal constant TEST_KEY = 0xA11CE;
    address internal deployer;
    address internal safe;

    function setUp() public {
        vm.chainId(11155111);
        deployer = vm.addr(TEST_KEY);
        safe = makeAddr("deployed-safe-fixture");
        vm.etch(safe, hex"00");
        vm.etch(USDC, address(new MockERC20("USD Coin", "USDC", 6)).code);
        vm.mockCall(USDC, abi.encodeWithSignature("decimals()"), abi.encode(uint8(6)));
        vm.etch(COORDINATOR, address(new MockVRF()).code);
        vm.setEnv("SAFE_ADDRESS", vm.toString(safe));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(TEST_KEY));
        vm.setEnv("TERMS_HASH", vm.toString(TERMS));
        vm.setEnv("VRF_SUBSCRIPTION_ID", vm.toString(SUBSCRIPTION));
        vm.setEnv("WIRE_ETH_PATH", "false");
        vm.setEnv("UNISWAP_POOL_FEE", "3000");
    }

    function _deploy() internal returns (LabxRaffle labx) {
        labx = LabxRaffle(payable(vm.computeCreateAddress(deployer, vm.getNonce(deployer))));
        new DeploySepolia().run();
        assertGt(address(labx).code.length, 0);
    }

    function test_runEnablesNativeBillingWithEthPurchasesOff() public {
        vm.expectEmit();
        emit LabxRaffle.NativePaymentSet(true);
        vm.expectEmit();
        emit LabxRaffle.OwnershipTransferStarted(deployer, safe);
        LabxRaffle labx = _deploy();
        assertTrue(labx.nativePayment());
        assertFalse(labx.ethPathEnabled());
        assertEq(labx.router(), address(0));
        assertEq(labx.weth(), address(0));
        assertEq(labx.ethUsdFeed(), address(0));
        assertEq(labx.owner(), deployer);
        assertEq(labx.pendingOwner(), safe);
        assertEq(labx.treasury(), safe);
        assertEq(address(labx.usdc()), USDC);
        assertEq(labx.vrfCoordinator(), COORDINATOR);
        assertEq(labx.keyHash(), KEY_HASH);
        assertEq(labx.subscriptionId(), SUBSCRIPTION);
        assertEq(labx.termsHash(), TERMS);
        assertEq(labx.callbackGasLimit(), 500_000);
        assertEq(labx.requestConfirmations(), 3);
        assertEq(labx.poolFee(), 3000);
    }

    function test_runRefusesMainnetAndLocalChainBeforeDeploying() public {
        DeploySepolia script = new DeploySepolia();
        uint64 nonce = vm.getNonce(deployer);
        vm.chainId(1);
        vm.expectRevert("LABx: Sepolia only. Mainnet is disabled.");
        script.run();
        vm.chainId(31337);
        vm.expectRevert("LABx: Sepolia only. Mainnet is disabled.");
        script.run();
        assertEq(vm.getNonce(deployer), nonce);
    }

    function test_runRefusesUndeployedSafeBeforeDeploying() public {
        DeploySepolia script = new DeploySepolia();
        vm.etch(safe, hex"");
        uint64 nonce = vm.getNonce(deployer);
        vm.expectRevert(abi.encodeWithSelector(DeploySepolia.SafeNotDeployed.selector, safe));
        script.run();
        assertEq(vm.getNonce(deployer), nonce);
    }

    function test_safeAcceptancePreservesBillingAndRevokesDeployerAuthority() public {
        LabxRaffle labx = _deploy();
        vm.prank(safe);
        labx.acceptOwnership();
        assertEq(labx.owner(), safe);
        assertEq(labx.pendingOwner(), address(0));
        assertTrue(labx.nativePayment());
        vm.prank(deployer);
        vm.expectRevert(LabxRaffle.NotOwner.selector);
        labx.setNativePayment(false);
        vm.prank(safe);
        labx.setNativePayment(false);
        assertFalse(labx.nativePayment());
    }

    function test_scriptDeploymentPinsRequestBillingAndRecoveryDeadline() public {
        LabxRaffle labx = _deploy();
        vm.prank(safe);
        labx.acceptOwnership();
        uint64 end = uint64(vm.getBlockTimestamp() + 2 days);
        uint256 nativeId = _openAndBuy(labx, end, 1);
        assertTrue(labx.getRafflePolicy(nativeId).nativePayment);
        vm.prank(safe);
        labx.setNativePayment(false);
        uint256 linkId = _openAndBuy(labx, end, 2);
        assertFalse(labx.getRafflePolicy(linkId).nativePayment);
        assertEq(labx.getRaffle(nativeId).salesEnd, end);
        assertEq(labx.getRaffle(linkId).salesEnd, end);

        vm.warp(end);
        _request(labx, nativeId, true, 1);
        vm.prank(safe);
        labx.setNativePayment(true);
        _request(labx, linkId, false, 2);
        assertEq(labx.getRaffle(nativeId).vrfRequestedAt, end);
        MockVRF(COORDINATOR).fulfill(address(labx), 2, 0);
        assertEq(labx.getRaffle(linkId).winner, makeAddr("buyer"));

        vm.prank(safe);
        labx.setNativePayment(false);
        uint256 cutoff = uint256(end) + 7 days;
        vm.warp(cutoff - 1);
        vm.expectRevert(LabxRaffle.TooEarly.selector);
        labx.abortDrawing(nativeId);
        assertEq(labx.getRaffle(nativeId).vrfRequestedAt, end);
        assertTrue(labx.getRafflePolicy(nativeId).nativePayment);
        vm.warp(cutoff);
        labx.abortDrawing(nativeId);
        MockVRF(COORDINATOR).fulfill(address(labx), 1, 0);
        assertEq(uint256(labx.getRaffle(nativeId).phase), uint256(LabxRaffle.Phase.Cancelled));
        assertEq(labx.getRaffle(nativeId).winner, address(0));
        vm.prank(makeAddr("buyer"));
        labx.refund(nativeId);
        assertEq(MockERC20(USDC).balanceOf(makeAddr("buyer")), 30_000_000);
    }

    function _openAndBuy(LabxRaffle labx, uint64 end, uint256 tokenId) internal returns (uint256 id) {
        address seller = makeAddr("seller");
        address buyer = makeAddr("buyer");
        MockERC721 nft = new MockERC721();
        nft.mint(seller, tokenId);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig("Membership", 25e6, 3, 100);
        vm.startPrank(seller);
        nft.approve(address(labx), tokenId);
        id = labx.createRaffle(
            address(nft), tokenId, end, bytes32(tokenId), keccak256("commit"), "Deployment test", packs
        );
        labx.escrow(id);
        _approveAdmission(labx, id);
        labx.open(id);
        vm.stopPrank();
        MockERC20(USDC).mint(buyer, 30e6);
        vm.startPrank(buyer);
        MockERC20(USDC).approve(address(labx), 30e6);
        labx.buyPack(id, 0, 1, TERMS);
        vm.stopPrank();
    }

    function _request(LabxRaffle labx, uint256 id, bool nativeBilling, uint256 requestId) internal {
        labx.close(id);
        labx.snapshot(id, 100);
        bytes memory request = abi.encodeCall(
            MockVRF.requestRandomWords,
            (VRFV2PlusClient.RandomWordsRequest({
                    keyHash: KEY_HASH,
                    subId: SUBSCRIPTION,
                    requestConfirmations: 3,
                    callbackGasLimit: 500_000,
                    numWords: 1,
                    extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: nativeBilling}))
                }))
        );
        vm.mockCall(COORDINATOR, request, abi.encode(requestId));
        vm.expectCall(COORDINATOR, request, 1);
        vm.prank(makeAddr("seller"));
        labx.requestRandomness(id);
    }

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
