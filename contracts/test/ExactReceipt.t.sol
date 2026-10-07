// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {AdmissionFixture} from "./AdmissionFixture.sol";
import {LabxRaffle} from "../src/LabxRaffle.sol";
import {MockERC20, MockERC721, MockVRF} from "./mocks/Mocks.sol";

contract ReceiptToken is MockERC20 {
    uint256 internal received;
    bool internal failing;
    constructor() MockERC20("Receipt token", "R", 6) {}

    function setReceipt(uint256 amount, bool fail) external {
        received = amount;
        failing = fail;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (failing) return false;
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        if (received == type(uint256).max) balanceOf[to] -= 1;
        else balanceOf[to] += received;
        return true;
    }
}

contract ExactReceiptTest is AdmissionFixture {
    function _fixture(ReceiptToken token) internal returns (LabxRaffle labx, uint256 id) {
        MockERC721 nft = new MockERC721();
        labx = new LabxRaffle(
            LabxRaffle.Init({
                treasury: address(99),
                usdc: address(token),
                router: address(0),
                weth: address(0),
                ethUsdFeed: address(0),
                poolFee: 3000,
                vrfCoordinator: address(new MockVRF()),
                keyHash: bytes32(uint256(1)),
                subscriptionId: 1,
                termsHash: bytes32(uint256(2)),
                callbackGasLimit: 500_000,
                requestConfirmations: 3
            })
        );
        nft.mint(address(this), 1);
        nft.approve(address(labx), 1);
        LabxRaffle.PackConfig[] memory packs = new LabxRaffle.PackConfig[](1);
        packs[0] = LabxRaffle.PackConfig("Entry", 25e6, 1, 100);
        id = labx.createRaffle(
            address(nft),
            1,
            uint64(block.timestamp + 1 days),
            bytes32(uint256(3)),
            bytes32(uint256(4)),
            "Exact receipt",
            packs
        );
        labx.escrow(id);
        _approveAdmission(labx, id);
        labx.open(id);
    }

    function testFuzz_inexactReceiptsRollbackEveryCreditAndTransfer(uint8 mode) public {
        ReceiptToken token = new ReceiptToken();
        (LabxRaffle labx, uint256 id) = _fixture(token);
        address alice = address(123);
        uint256 total = 27_500_000;
        uint256 selected = mode % 5;
        token.setReceipt(
            selected == 0 ? 0 : selected == 1 ? total - 1 : selected == 4 ? type(uint256).max : total + 1, selected == 3
        );
        token.mint(alice, total);
        token.mint(address(labx), 1);
        vm.prank(alice);
        token.approve(address(labx), total);
        vm.prank(alice);
        vm.expectRevert();
        labx.buyPack(id, 0, 1, bytes32(uint256(2)));
        assertEq(token.balanceOf(alice), total);
        assertEq(token.balanceOf(address(labx)), 1);
        assertEq(token.allowance(alice, address(labx)), total);
        assertEq(labx.getRaffle(id).principalEscrow, 0);
        assertEq(labx.getRaffle(id).feeEscrow, 0);
        assertEq(labx.getRaffleAccounting(id).buyerFees, 0);
        assertEq(labx.getPack(id, 0).sold, 0);
        assertEq(labx.lotCount(id), 0);
        token.setReceipt(total, false);
        vm.prank(alice);
        labx.buyPack(id, 0, 1, bytes32(uint256(2)));
        assertEq(labx.principalOf(id, alice), 25e6);
        assertEq(labx.feeOf(id, alice), 2_500_000);
    }
}
