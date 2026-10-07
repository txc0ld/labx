# Verified v3 Sepolia registration

Base source: `605eb9cab2841e7ffce3f5bcb074ed56fa66406b`. This change registers the user-deployed v3 instance after canonical deployment, configuration, consumer registration and Safe acceptance verification. It changes the approval registry, its regression tests and current operational documentation. Solidity, action trust, wallet signing, journal and confirmation rules are unchanged.

| Manifest field | Verified value |
| --- | --- |
| Network | Ethereum Sepolia, 11155111 |
| Contract | `0x8b0332D0ca48908e174F42eA1b3123e63f3F4327` |
| Creation block | `11865781` |
| Runtime hash | `0x566af43a3c4310211e5214168fab8c72c2996e01ebd4351f154bf88f1453eb31` |
| Owner and treasury | `0x97C3C44378571FeE5D11593ee11f26a8626Bdfd1` |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Coordinator | `0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B` |
| Subscription | `87872268328198099397228888276383491550742527734296569403303774370612241641662` |
| Key hash | `0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae` |
| Terms hash | `0x653a59619128ccbd7b75b40db072ff9aab5c5a547caf1ccaf9de67079c463f25` |
| VRF request | Native billing, 500,000 callback gas, 3 confirmations |
| Fees | Buyer 200 bps with 2,500,000 atomic-USDC minimum; seller 200 bps |

The root verifier reconstructed four deployer transactions and verified the Safe's canonical `acceptOwnership` execution `0xff3945e774777c0cee1487724f8e7da77851f50791798745da646325bd7c48ea`. At checked block 11865827, the expected Safe owned the raffle, pending owner and coordinator were zero, the consumer was registered, and `nextId` was 1. These are dated observations, not promises about later mutable state.

`NEXT_PUBLIC_RAFFLE_ADDRESS` selects this exact registered address. The public RPC is `https://ethereum-sepolia-rpc.publicnode.com`. An unknown, historical or unset selection stays unavailable. Runtime attestation and action-specific authority/policy checks still run. Individual raffles require human review and approval. The Safe threshold of one is for Sepolia testing only. ETH membership purchases are disabled; native VRF billing does not enable that purchase route.

Registration proves neither a completed live Chainlink raffle lifecycle nor NFT authenticity or future subscription funding. Mainnet is not registered. The live lifecycle exercise remains separate. Existing historical contracts, entries, custody and claims are not migrated by this frontend change.

Evidence is in the enclosing task workspace at `artifacts/v3-sepolia-activation-20261008/execution-verification/`, with the exact manifest in `packet/activation-proposal.json` and implementation checks in `execution-verification/builder/`. The packet's earlier inert-proposal label predates the verified execution and this registration contract. Independent live-state verification, source review, hosted CI and release verification remain root-owned gates. No transaction was sent by this implementation task.

## Hosted storage limitation

At registration preparation, root's production environment inventory reported no `UPSTASH_REDIS_REST_URL` or `UPSTASH_REDIS_REST_TOKEN`. `activeStore()` refuses hosted requests without durable Redis. Seller commitment saving/recovery and buyer agreement recording therefore remain unavailable until storage is configured. The website requires an acknowledged agreement before presenting purchase submission, and a saved commitment before draft creation. Read-only contract browsing and wallet connection do not establish those flows work. No ephemeral hosted fallback or storage change is included here.
