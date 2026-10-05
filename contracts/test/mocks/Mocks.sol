// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {VRFV2PlusClient} from "../../src/vendor/VRFV2PlusClient.sol";
import {ISwapRouter02} from "../../src/interfaces/External.sol";
import {LabxRaffle} from "../../src/LabxRaffle.sol";

contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract MockERC721 is IERC721 {
    mapping(uint256 => address) internal _owner;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 id) external {
        require(_owner[id] == address(0), "minted");
        _owner[id] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, id);
    }

    function ownerOf(uint256 id) public view returns (address) {
        address o = _owner[id];
        require(o != address(0), "missing");
        return o;
    }

    function approve(address spender, uint256 id) external {
        require(ownerOf(id) == msg.sender, "owner");
        getApproved[id] = spender;
        emit Approval(msg.sender, spender, id);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 id) public virtual {
        address o = ownerOf(id);
        require(o == from, "from");
        require(msg.sender == from || msg.sender == getApproved[id] || isApprovedForAll[from][msg.sender], "auth");
        getApproved[id] = address(0);
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        _owner[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) public virtual {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, id, data)
                    == IERC721Receiver.onERC721Received.selector,
                "receiver"
            );
        }
    }

    function supportsInterface(bytes4) external pure returns (bool) {
        return true;
    }
}

contract MaliciousERC721 is MockERC721 {
    LabxRaffle public target;
    bool public attack;

    function setTarget(address t) external {
        target = LabxRaffle(payable(t));
        attack = true;
    }

    function safeTransferFrom(address from, address to, uint256 id) public override {
        super.safeTransferFrom(from, to, id);
        if (attack && address(target) != address(0)) {
            attack = false;
            target.buyPack(1, 0, 1, target.termsHash());
        }
    }
}

contract MockFeed {
    int256 public answer = 2000e8;
    uint256 public updatedAt;
    uint8 public dec = 8;

    constructor() {
        updatedAt = block.timestamp;
    }

    function decimals() external view returns (uint8) {
        return dec;
    }

    function setAnswer(int256 a) external {
        answer = a;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function setDecimals(uint8 d) external {
        dec = d;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, 0, updatedAt, 1);
    }
}

contract MockWETH {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "eth");
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    receive() external payable {}
}

contract MockRouter is ISwapRouter02 {
    MockWETH public weth;
    MockERC20 public usdc;
    uint256 public spendNumerator = 1;
    uint256 public spendDenominator = 2;

    constructor(MockWETH w, MockERC20 u) {
        weth = w;
        usdc = u;
    }

    function setSpend(uint256 numerator, uint256 denominator) external {
        spendNumerator = numerator;
        spendDenominator = denominator;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params) external payable returns (uint256 amountIn) {
        amountIn = params.amountInMaximum * spendNumerator / spendDenominator;
        if (amountIn == 0 && spendNumerator != 0) amountIn = params.amountInMaximum;
        weth.transferFrom(msg.sender, address(this), amountIn);
        usdc.mint(params.recipient, params.amountOut);
    }

    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results) {
        require(deadline >= block.timestamp, "deadline");
        results = new bytes[](data.length);
        for (uint256 i = 0; i < data.length; ++i) {
            (bool ok, bytes memory ret) = address(this).delegatecall(data[i]);
            require(ok, "multicall");
            results[i] = ret;
        }
    }
}

/// @notice Accepts `transferFrom` and reverts `onERC721Received`, so a safe-transfer claim would stick.
contract RevertingReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        revert("nope");
    }
}

/// @notice Escrow succeeds, then every outbound transfer reverts.
contract StickyERC721 is MockERC721 {
    bool public locked;

    function safeTransferFrom(address from, address to, uint256 id) public override {
        super.safeTransferFrom(from, to, id);
        locked = true;
    }

    function transferFrom(address from, address to, uint256 id) public override {
        require(!locked, "sticky");
        super.transferFrom(from, to, id);
    }
}

/// @notice Fulfills inside `requestRandomWords`, before the consumer stores the request id.
contract SyncVRF {
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata) external returns (uint256 id) {
        id = 77;
        uint256[] memory words = new uint256[](1);
        words[0] = 4;
        LabxRaffle(payable(msg.sender)).rawFulfillRandomWords(id, words);
    }
}

contract MockVRF {
    uint256 public next = 1;
    bool public lastNativePayment;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req) external returns (uint256 id) {
        lastNativePayment = abi.decode(req.extraArgs[4:], (bool));
        id = next++;
    }

    function fulfill(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        LabxRaffle(payable(consumer)).rawFulfillRandomWords(requestId, words);
    }
}
