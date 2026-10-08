# Wallet NFT picker

Base: `1d15fe95f398a35b726f3e936bc489c5b93a06b0`

The seller draft form can load bounded ERC-721 inventory for the connected Ethereum Sepolia wallet through a same-origin server route. The route keeps the Alchemy key on the server, fixes the upstream network and endpoint, validates and normalizes responses, and applies per-process cache, rate, coalescing, response-size and concurrency limits. Manual NFT entry remains available.

Choosing an NFT performs a fresh pinned `ownerOf` read through the configured raffle service before it applies the NFT address and token ID. Wallet, service, request and form generations prevent delayed inventory or ownership responses from crossing identity changes or overwriting later edits. Selection never asks for a signature or sends a transaction. Existing preparation, storage, owner checks and transaction confirmation remain in place.

The seller preparation boundary now maps wallet rejection and other save/sign failures to static messages, so an echoed signed payload cannot reach the page. Existing edits retain their setup without another storage signature when the NFT identity is unchanged, while the preparation copy still states that successful edits require fresh LABx approval.

Focused builder checks on the source candidate:

- `npm test -- --run test/wallet-nfts.test.ts test/automatic-commitment.test.ts`: PASS, 20 tests.
- `npx tsc --noEmit --pretty false`: PASS.

Full tests, production build, browser acceptance, independent verification and fresh final review are separate required gates. Full builder logs are in the ignored protected directory `artifacts/wallet-nft-picker-20261008/builder/`.
