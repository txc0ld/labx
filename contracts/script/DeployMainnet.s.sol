// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";

interface IVRFSubscriptionAdmin {
    function createSubscription() external returns (uint256 subId);
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] memory consumers);
    function addConsumer(uint256 subId, address consumer) external;
    function fundSubscriptionWithNative(uint256 subId) external payable;
    function requestSubscriptionOwnerTransfer(uint256 subId, address newOwner) external;
}

interface ISafeOwners {
    function getThreshold() external view returns (uint256);
}

/// @notice Chain-1 addresses and checks shared by both deployment stages.
/// @dev Procedure. The deployer key signs these two scripts and nothing else until the Safe has accepted both transfers.
///      Keep forge's broadcast/ run files from every run: both stages write run-latest.json in the same directory, so
///      keep the timestamped run-<time>.json copies.
///      1. Stage 1, CreateMainnetSubscription, creates the VRF subscription. Read its ID from the mined receipt, never
///         from the simulation: `cast receipt <tx> --json`, the SubscriptionCreated log whose emitter is the
///         coordinator and whose owner (the log data) is the deployer; the ID is topic 1.
///      2. Before stage 2, write into the deployment record: the stage 1 tx hash, its nonce (`cast tx <tx> nonce`),
///         the ID, EXPECTED_NONCE (that nonce + 1) and the raffle's CREATE address
///         (`cast compute-address <deployer> --nonce <EXPECTED_NONCE>`).
///      3. Stage 2, DeployMainnet, with DEPLOY_MODE=fresh, EXPECTED_NONCE, VRF_SUBSCRIPTION_ID, FUND_TARGET_WEI,
///         TERMS_HASH, SAFE_ADDRESS and no RAFFLE_ADDRESS. A fresh run refuses a deployer nonce other than
///         EXPECTED_NONCE, and a subscription that is not the deployer's, has a pending owner or has a consumer. It
///         logs the CREATE address, which must match the record. Write every stage 2 tx hash into the record.
///      4. If stage 2 stops part way, settle every pending transaction (mined, replaced or cancelled) and read each
///         receipt. If the deployer nonce is still EXPECTED_NONCE, nothing mined and a fresh run may repeat. A moved
///         nonce alone does not prove the CREATE succeeded: a CREATE that reverted or ran out of gas, or another
///         transaction at that nonce, also moves it and leaves no code. Resume only when the CREATE's canonical receipt
///         has status 1 and the recorded address has code: rerun with DEPLOY_MODE=resume and RAFFLE_ADDRESS set to it.
///         A resume refuses a raffle whose code, settings or ownership differ from a fresh deployment, sends only the
///         missing steps, and funds only up to FUND_TARGET_WEI. If the CREATE failed or was replaced, record that,
///         start a new deployment record with the current nonce as EXPECTED_NONCE and its predicted address, check the
///         subscription is still untouched, and run fresh again. EXPECTED_NONCE never changes without that record.
///      5. The Safe accepts both transfers, checks the state, and unpauses the raffle only at launch.
///      Every check runs in forge's simulation, so a refusal stops the run before anything is sent.
abstract contract MainnetDeployment is Script {
    error SafeNotDeployed(address safe);
    error SafeThresholdTooLow(address safe, uint256 threshold);
    error SubscriptionNotOwned(uint256 subId, address owner);
    error CoordinatorLayoutChanged(uint256 subId);

    // Read on chain 1 on 19 October 2026: Circle USDC (6 decimals), the Chainlink VRF v2.5 coordinator and its 200 gwei
    // key hash (s_provingKeys returned exists with maxGas 200 gwei).
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant VRF_COORDINATOR = 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a;
    bytes32 internal constant VRF_KEY_HASH = 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9;
    // Fixed, not an input: the costliest callback measured under Sepolia's October 2026 gas repricing used 264,740 gas,
    // and 250,000 failed. It also sets the reserve Chainlink expects before answering a draw.
    uint32 internal constant CALLBACK_GAS_LIMIT = 400_000;
    uint16 internal constant REQUEST_CONFIRMATIONS = 3;
    // The coordinator's s_subscriptionConfigs mapping (VRF v2.5 SubscriptionAPI): {owner, requestedOwner, consumers}.
    uint256 private constant SUBSCRIPTION_CONFIGS_SLOT = 5;

    struct Subscription {
        uint96 nativeBalance;
        address owner;
        address requestedOwner;
        address[] consumers;
    }

    function _requireMainnet() internal view {
        if (block.chainid != 1) revert("LABx: mainnet only.");
    }

    /// @dev Refuses an EOA, an undeployed Safe, or a Safe that one key can control.
    function _validateSafe(address safe) internal view {
        if (safe.code.length == 0) revert SafeNotDeployed(safe);
        uint256 threshold = ISafeOwners(safe).getThreshold();
        if (threshold < 2) revert SafeThresholdTooLow(safe, threshold);
    }

    /// @dev getSubscription omits the pending owner, so this reads it from the coordinator's storage, and refuses if the
    ///      owner and consumer count stored beside it disagree with getSubscription. Reverts InvalidSubscription for an
    ///      ID that was never mined, such as one taken from a simulation.
    function _subscription(uint256 subId) internal view returns (Subscription memory s) {
        (, s.nativeBalance,, s.owner, s.consumers) = IVRFSubscriptionAdmin(VRF_COORDINATOR).getSubscription(subId);
        uint256 base = uint256(keccak256(abi.encode(subId, SUBSCRIPTION_CONFIGS_SLOT)));
        if (_coordinatorWord(base) != uint160(s.owner) || _coordinatorWord(base + 2) != s.consumers.length) {
            revert CoordinatorLayoutChanged(subId);
        }
        s.requestedOwner = address(uint160(_coordinatorWord(base + 1)));
    }

    function _coordinatorWord(uint256 slot) private view returns (uint256) {
        return uint256(vm.load(VRF_COORDINATOR, bytes32(slot)));
    }
}

/// @notice Stage 1: creates the VRF subscription, owned by the deployer. The coordinator derives the ID from the mined
///         block and its subscription nonce, so a simulated ID can differ from the real one. Read the ID from the
///         SubscriptionCreated event in the mined receipt and pass that to DeployMainnet; never reuse this script's output.
contract CreateMainnetSubscription is MainnetDeployment {
    function run() external {
        _requireMainnet();
        _create(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        console2.log(
            "Read the subscription ID from SubscriptionCreated in the mined receipt, not from this simulation."
        );
    }

    function _create(uint256 pk) internal {
        _requireMainnet();
        vm.startBroadcast(pk);
        IVRFSubscriptionAdmin(VRF_COORDINATOR).createSubscription();
        vm.stopBroadcast();
    }
}

/// @notice Stage 2: deploys the raffle pinned to the mined subscription, funds the subscription up to a target, and
///         offers both to the Safe. The raffle starts paused from its constructor. DEPLOY_MODE must say which run this
///         is. A fresh run only accepts the recorded deployer nonce and the untouched stage 1 subscription; a resume
///         needs RAFFLE_ADDRESS, only accepts a raffle identical to a fresh deployment, and sends only the missing steps.
///         Every other chain id is refused.
contract DeployMainnet is MainnetDeployment {
    error DeployModeInvalid(string mode);
    error RaffleAddressUnexpected(address raffle);
    error RaffleAddressMissing();
    error NonceMoved(uint256 expected, uint256 actual);
    error SubscriptionInUse(uint256 subId);
    error RaffleCodeMismatch(address raffle);
    error RaffleSettingMismatch(string setting);
    error RaffleOwnershipUnexpected(address owner, address pendingOwner);
    error SubscriptionOwnershipUnexpected(address owner, address requestedOwner);
    error SubscriptionConsumersUnexpected(uint256 subId);
    error SafeActionRequired(string action);

    struct Config {
        address safe;
        uint256 pk;
        bytes32 terms;
        // The subscription's native balance after the run; only the shortfall is sent.
        uint256 fundTarget;
        // The ID from the mined SubscriptionCreated event of stage 1.
        uint256 subId;
        // DEPLOY_MODE=fresh or DEPLOY_MODE=resume.
        bool fresh;
        // Fresh only: the deployer nonce the raffle CREATE uses, from the deployment record (stage 1 nonce + 1).
        uint256 expectedNonce;
        // Resume only: the raffle from the deployment record.
        address existing;
    }

    function run() external returns (LabxRaffle labx) {
        _requireMainnet();
        return _deploy(_config());
    }

    /// @dev Reads the mode before anything else; an unset DEPLOY_MODE reads as "" and is refused.
    function _config() internal view returns (Config memory c) {
        string memory mode = vm.envOr("DEPLOY_MODE", string(""));
        c.fresh = keccak256(bytes(mode)) == keccak256("fresh");
        if (!c.fresh && keccak256(bytes(mode)) != keccak256("resume")) revert DeployModeInvalid(mode);
        if (c.fresh) c.expectedNonce = vm.envUint("EXPECTED_NONCE");
        c.existing = vm.envOr("RAFFLE_ADDRESS", address(0));
        c.safe = vm.envAddress("SAFE_ADDRESS");
        c.pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        c.terms = vm.envBytes32("TERMS_HASH");
        c.fundTarget = vm.envUint("FUND_TARGET_WEI");
        c.subId = vm.envUint("VRF_SUBSCRIPTION_ID");
    }

    function _deploy(Config memory c) internal returns (LabxRaffle labx) {
        _requireMainnet();
        if (c.fresh && c.existing != address(0)) revert RaffleAddressUnexpected(c.existing);
        if (!c.fresh && c.existing == address(0)) revert RaffleAddressMissing();
        _validateSafe(c.safe);
        address deployer = vm.addr(c.pk);
        Subscription memory sub = _subscription(c.subId);
        if (sub.owner != deployer && sub.owner != c.safe) revert SubscriptionNotOwned(c.subId, sub.owner);
        LabxRaffle.Init memory init = _init(c);
        if (c.fresh) {
            // Any deployer transaction since stage 1, such as this raffle's CREATE from an interrupted run, moves the
            // nonce; that run must resume instead of deploying another raffle.
            uint256 nonce = vm.getNonce(deployer);
            if (nonce != c.expectedNonce) revert NonceMoved(c.expectedNonce, nonce);
            if (sub.owner != deployer || sub.requestedOwner != address(0) || sub.consumers.length != 0) {
                revert SubscriptionInUse(c.subId);
            }
            console2.log("Raffle CREATE address", vm.computeCreateAddress(deployer, c.expectedNonce));
        } else {
            _requireResumable(LabxRaffle(payable(c.existing)), init, c, deployer);
        }

        IVRFSubscriptionAdmin coordinator = IVRFSubscriptionAdmin(VRF_COORDINATOR);
        vm.startBroadcast(c.pk);
        labx = c.fresh ? new LabxRaffle(init) : LabxRaffle(payable(c.existing));
        if (labx.owner() == deployer && !labx.nativePayment()) labx.setNativePayment(true);
        if (sub.owner == deployer && !_contains(sub.consumers, address(labx))) {
            coordinator.addConsumer(c.subId, address(labx));
        }
        if (sub.nativeBalance < c.fundTarget) {
            coordinator.fundSubscriptionWithNative{value: c.fundTarget - sub.nativeBalance}(c.subId);
        }
        if (labx.owner() == deployer && labx.pendingOwner() != c.safe) labx.transferOwnership(c.safe);
        if (sub.owner == deployer && sub.requestedOwner != c.safe) {
            coordinator.requestSubscriptionOwnerTransfer(c.subId, c.safe);
        }
        vm.stopBroadcast();

        _requireHandoff(labx, c, deployer);
        console2.log("LabxRaffle", address(labx));
        console2.log("VRF subscription", c.subId);
        console2.log(
            "Record the raffle address and every tx hash. The Safe accepts both transfers, then unpauses at launch."
        );
    }

    function _init(Config memory c) private pure returns (LabxRaffle.Init memory) {
        return LabxRaffle.Init({
            treasury: c.safe,
            usdc: USDC,
            router: address(0),
            weth: address(0),
            ethUsdFeed: address(0),
            poolFee: 0,
            vrfCoordinator: VRF_COORDINATOR,
            keyHash: VRF_KEY_HASH,
            subscriptionId: c.subId,
            termsHash: c.terms,
            callbackGasLimit: CALLBACK_GAS_LIMIT,
            requestConfirmations: REQUEST_CONFIRMATIONS
        });
    }

    /// @dev The raffle must be what a fresh run of this script deploys, still owned by the deployer (with nothing or the
    ///      Safe pending) or already by the Safe. The reference raffle is created outside the broadcast, so it exists
    ///      only in the simulation; its code hash covers the compiled code and every immutable.
    function _requireResumable(LabxRaffle labx, LabxRaffle.Init memory init, Config memory c, address deployer)
        private
    {
        if (address(labx).codehash != address(new LabxRaffle(init)).codehash) {
            revert RaffleCodeMismatch(address(labx));
        }
        _requireReviewedSettings(labx, c);
        address owner = labx.owner();
        address pending = labx.pendingOwner();
        if (!_offeredTo(owner, pending, deployer, c.safe) && !(owner == deployer && pending == address(0))) {
            revert RaffleOwnershipUnexpected(owner, pending);
        }
    }

    /// @dev Every owner-settable default, as a fresh deployment has it. USDC, the unwired ETH route and the fee
    ///      constants are part of the code, so the code hash covers them. Native billing is the one default this script
    ///      changes, and _requireHandoff checks it.
    function _requireReviewedSettings(LabxRaffle labx, Config memory c) private view {
        _requireSetting(labx.treasury() == c.safe, "treasury");
        _requireSetting(labx.vrfCoordinator() == VRF_COORDINATOR, "vrfCoordinator");
        _requireSetting(labx.pendingCoordinator() == address(0) && labx.coordinatorEta() == 0, "pendingCoordinator");
        _requireSetting(labx.keyHash() == VRF_KEY_HASH, "keyHash");
        _requireSetting(labx.subscriptionId() == c.subId, "subscriptionId");
        _requireSetting(labx.termsHash() == c.terms, "termsHash");
        _requireSetting(labx.callbackGasLimit() == CALLBACK_GAS_LIMIT, "callbackGasLimit");
        _requireSetting(labx.requestConfirmations() == REQUEST_CONFIRMATIONS, "requestConfirmations");
        _requireSetting(!labx.ethPathEnabled(), "ethPathEnabled");
        _requireSetting(labx.paused(), "paused");
    }

    /// @dev What the Safe should find before accepting: the reviewed settings, native billing, the raffle as the
    ///      subscription's only consumer, and both resources owned by or offered to the Safe. A step the deployer can no
    ///      longer take is named as a Safe action instead of being reported as done.
    function _requireHandoff(LabxRaffle labx, Config memory c, address deployer) private view {
        _requireReviewedSettings(labx, c);
        Subscription memory sub = _subscription(c.subId);
        if (!_contains(sub.consumers, address(labx))) {
            revert SafeActionRequired("coordinator.addConsumer(subId, raffle)");
        }
        if (sub.consumers.length != 1) revert SubscriptionConsumersUnexpected(c.subId);
        if (!labx.nativePayment()) revert SafeActionRequired("raffle.setNativePayment(true)");
        if (!_offeredTo(labx.owner(), labx.pendingOwner(), deployer, c.safe)) {
            revert RaffleOwnershipUnexpected(labx.owner(), labx.pendingOwner());
        }
        if (!_offeredTo(sub.owner, sub.requestedOwner, deployer, c.safe)) {
            revert SubscriptionOwnershipUnexpected(sub.owner, sub.requestedOwner);
        }
    }

    /// @dev The Safe owns it with nothing pending, or the deployer owns it with the Safe pending.
    function _offeredTo(address owner, address pending, address deployer, address safe) private pure returns (bool) {
        return (owner == safe && pending == address(0)) || (owner == deployer && pending == safe);
    }

    function _requireSetting(bool matches, string memory setting) private pure {
        if (!matches) revert RaffleSettingMismatch(setting);
    }

    function _contains(address[] memory items, address item) private pure returns (bool) {
        for (uint256 i = 0; i < items.length; i++) {
            if (items[i] == item) return true;
        }
        return false;
    }
}
