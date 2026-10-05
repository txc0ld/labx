// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Per-network addresses and launch parameters for the LABx deployment scripts.
/// @dev Ethereum mainnet values are included for reference only. `Deploy.s.sol` refuses to run on
///      mainnet: this repository is develop + Sepolia only, and a mainnet launch is a separate,
///      deliberate decision gated by `docs/launch-checklist.md`.
library LabxConfig {
    uint256 internal constant MAINNET = 1;
    uint256 internal constant SEPOLIA = 11_155_111;

    struct Network {
        string name;
        address usdc;
        address weth;
        address uniswapRouter; // Uniswap SwapRouter02
        address ethUsdFeed; // Chainlink ETH/USD
        address vrfCoordinator; // Chainlink VRF v2.5 coordinator
        bytes32 vrfKeyHash;
        uint24 uniswapPoolFee;
    }

    function network(uint256 chainId) internal pure returns (Network memory config) {
        if (chainId == SEPOLIA) {
            return Network({
                name: "sepolia",
                // Circle's official Sepolia USDC (6 decimals).
                usdc: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
                weth: 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14,
                uniswapRouter: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E,
                ethUsdFeed: 0x694AA1769357215DE4FAC081bf1f309aDC325306,
                vrfCoordinator: 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B,
                vrfKeyHash: 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae,
                uniswapPoolFee: 500
            });
        }
        if (chainId == MAINNET) {
            return Network({
                name: "mainnet",
                usdc: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
                weth: 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2,
                uniswapRouter: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45,
                ethUsdFeed: 0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419,
                vrfCoordinator: 0xD7f86b4b8Cae7D942340FF628F82735b7a20893a,
                vrfKeyHash: 0x8077df514608a09f83e4e8d300645594e5d7234665448ba83f51a50f842bd3d9,
                uniswapPoolFee: 500
            });
        }
        revert("LabxConfig: unsupported chain");
    }

    /// @notice The launch membership packs. Prices are in USDC (6 decimals) and divide exactly by their
    ///         entry count, so each pack has a round value-per-entry ($5.00 down to $3.00).
    struct Pack {
        string name;
        uint96 priceUsdc;
        uint32 entries;
        uint16 discountBps;
        uint8 rank;
    }

    function launchPacks() internal pure returns (Pack[] memory packs) {
        packs = new Pack[](5);
        packs[0] = Pack("Entry", 25e6, 5, 0, 1);
        packs[1] = Pack("Bronze", 54e6, 12, 250, 2);
        packs[2] = Pack("Silver", 100e6, 25, 500, 3);
        packs[3] = Pack("Gold", 245e6, 70, 750, 4);
        packs[4] = Pack("Platinum", 450e6, 150, 1_000, 5);
    }
}
