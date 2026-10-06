# LABx v2 release and migration plan

This is a plan for a separately authorized Sepolia release. It does not authorize publishing, deploying, transferring assets or ownership, funding a subscription, or accepting agreements. The current local workflow checkpoint is [docs/build/full-workflow-20261006.md](docs/build/full-workflow-20261006.md).

## 1. Freeze the source candidate

Record the exact commit, clean working tree, compiler and optimizer settings, dependency locks, generated ABI and compiled creation/runtime artifacts. Require the contract regression/fuzz and size checks, web tests/build, isolated seller/buyer/recovery journeys, browser checks and independent review for that candidate. Later relevant changes require revalidation.

The v2 policy pins the full randomness configuration, terms and treasury when a raffle opens. Closing time and purchase economics then stay fixed. The draw-start, randomness and reveal grace periods are each seven days. There is no free-entry issuance or reroll. Global admission pause cannot block recovery or claims. Verify these properties in deployed configuration rather than inferring them from the website.

## 2. Inventory the historical deployment

Before any deployment decision, recheck `0xa59B62E76ee2cc0219f879ae10f2CC84c10bB59C` read-only. Record the block, bytecode, ownership, raffle phases, escrowed NFTs, token balances, liabilities and VRF subscription billing/funding.

Historical observation at block 11856552 on 2026-10-06: `nextId` was 1, the owner and pending owner/treasury addresses had no code, and the VRF subscription had 0 LINK, 0.05 native ETH and zero requests. The old randomness abort constant was 86,400 seconds. These observations may change and do not establish current readiness. Native ETH does not replace LINK for a LINK-billed request.

Existing bytecode does not acquire v2 rules. Do not import old entries, balances or custody into a new deployment by assumption. Preserve any outstanding old claims through a separately reviewed legacy path. A frontend address change is not an on-chain migration.

## 3. Verify authority and dependencies

- Verify the intended Safe implementation, owners, threshold, modules and intended authority. The script's code-presence check alone does not prove it is a correctly configured Safe.
- Review the exact USDC, coordinator, key hash, subscription, confirmations, callback gas, billing mode and treasury for the deployment. Confirm consumer-registration authority and fund the correct billing asset through the user's secure wallet flow.
- Publish and approve the exact versioned terms used by the app. `TERMS_HASH` must equal the canonical published document hash. A nonzero arbitrary hash is insufficient.
- Keep the optional ETH route disabled unless its immutable router, token, feed, pool liquidity, quote, deadline and surplus-refund paths have passed the required checks.

No AMOE signer, CAPTCHA or verified-person provider is part of v2. Membership purchases are the only source of bonus entries.

## 4. Obtain the human release decision

Present the frozen candidate, test/review evidence, deployment constructor values, intended Safe, subscription details, old-state inventory and remaining risks. The user must separately approve the new deployment and any funding/ownership operations. Credentials and real wallet confirmations remain in the user's secure flow; never print keys or store them in reports.

`DeploySepolia` accepts chain 11155111 only. `DeployLocal` accepts 31337 only and is for isolated fixtures. Mainnet is not a release target. A dry run is not a broadcast, and proposing ownership does not complete acceptance.

## 5. Verify the deployed instance before enabling writes

Verify deployed runtime against the frozen compiler artifact and exact constructor immutables. Record deployment block, chain, address, runtime code hash, version and USDC in an approved manifest. Confirm the Safe has accepted ownership and the coordinator recognizes the consumer. Read all policy constants and configuration back from chain.

Exercise a separately authorized Sepolia lifecycle with test assets: create/edit draft, approve/escrow NFT, checked opening, exact USDC approval, membership purchase, confirmed agreement/receipt, deadline close, batched snapshot, randomness, reveal/settlement, prize and separate proceeds/fee claims. Also verify timed cancellation, buyer refunds, seller NFT reclaim, paused recovery and late callbacks. Do not describe mock Anvil fulfillment as live Chainlink verification.

Only then add the reviewed manifest and configure the intended public address/RPC. An environment address by itself does not authorize v2 actions. The historical address remains excluded from v2 transactions.

## 6. Publish the website separately

Use Vercel root `web`. Review the environment's public origin, selected approved manifest/RPC and both durable-storage settings. If email receipts are enabled, configure and verify the delivery provider and sender. Do not revive retired entry-signing or bot-token settings.

Confirm the exact hosted commit and deployment state. Test its catalog, direct routes, wallet/network changes, purchase/claim review screens, keyboard/mobile layouts and receipt/history recovery. Preview and production aliases are different release destinations; record each explicitly.

Operational monitoring must cover subscription balance, pending draw deadlines, snapshot progress, failed receipts and durable-store errors. Rollback can disable new website actions but cannot reverse an on-chain transaction or rewrite an open raffle's policy. Preserve access to existing claims and recovery when changing frontend releases.
