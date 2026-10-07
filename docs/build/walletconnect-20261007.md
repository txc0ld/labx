# WalletConnect integration

## Scope and preflight

User requested WalletConnect setup while an independent Claude contract review runs. This is a separate frontend slice based on fetched main `f683c4753c360a411727ff91a69f8eb67c0fc858`; contract review remains pinned to `f3b3355971109c212f56d36b44515752915fda52`. Worktree `labx-walletconnect`, branch `feat/walletconnect-20261007`. No publication or production deployment is authorized by this request.

Risk R3 for provider selection at the wallet signature/transaction boundary. Existing cryptography, transaction preparation, account/chain checks, pending journal and deployment manifest must retain their guarantees. Root Astra preflight approves the bounded design below. A designated critical builder owns the implementation; independent verification and fresh Astra High review must inspect the final candidate. Wallet consent and any signing remain with the user.

## Baseline

The browser service constructs a cached WalletSession with window.ethereum. The profile and WalletGate call connect; header wallet icon navigates to profile. WalletSession revisions bind prepared actions to account and chain and revalidate before/after journal acquisition. Signature messages are domain-bound elsewhere. There is no connector manager or EIP-6963 discovery. viem is the only wallet dependency. APPROVED_DEPLOYMENTS is empty and remains so.

An existing syntactically valid NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID was found in Vercel for production and preview. It is public client configuration. It was copied only to this worktree's ignored web/.env.local with mode0600; no secrets or Vercel variables were changed. Live relay/project authorization has not yet been tested.

Registry metadata inspected today: @walletconnect/ethereum-provider latest is2.25.0 and depends on @reown/appkit1.8.19. Prefer the official provider and QR/mobile modal via one exact-pinned direct dependency, loaded only on explicit selection. Confirm actual installed types and modal behavior. Do not add wagmi or replace the existing viem/service architecture.

## Implementation contract

1. Add explicit Browser wallet and WalletConnect choices wherever the existing flow connects a wallet. Preserve the logo/header/navigation, restrained black/white controls, solid pillow buttons, accessibility, mobile layout and current style. Header may keep its profile link. Show concise pending/cancel/error states; disable only an unavailable connector.
2. Create one stable wallet authority shared by the browser service and UI. It may own a small connector controller or a bounded provider-replacement method on WalletSession. Never assign WalletConnect to window.ethereum or globally patch wallet providers. Preserve existing injected behavior and local31337 test fixtures.
3. Dynamically initialize the WalletConnect provider after a user click only. No QR, session proposal, wallet account request, signature, transaction or relay initialization on passive render. Request only Sepolia11155111 and the minimum required personal_sign/eth_sendTransaction and chain/session methods/events. Disable optional analytics/social/email/onramp/swap features where supported. No mainnet or arbitrary chain support. WalletConnect is disabled for local31337 fixtures.
4. Bind every wallet snapshot and prepared action to a monotonically increasing revision across provider changes. Selecting a connector, disconnecting, replacing a provider, account/chain change or session deletion must immediately invalidate old action reviews. Stale connect/refresh promises and old-provider events must never reactivate or mutate the current session. Retire old listeners.
5. Existing account, chain, nonce/journal and signature-domain checks remain authoritative. After any asynchronous wait before an RPC signature/transaction request, revalidate current provider identity and reviewed account/chain/revision. A disposed/replaced wallet cannot send or sign. Already-submitted transactions retain receipt/journal recovery. Never route a previously reviewed action into a newly selected wallet.
6. Disconnect WalletConnect remotely and locally, with bounded errors and no state resurrection; preserve injected local disconnect. Handle QR dismissal, rejection, expiry, wrong chain and repeated clicks. Allow reconnect explicitly. Do not silently auto-restore a WalletConnect session on page load in this slice; explicit selection may reuse an approved stored session only after fresh validation.
7. Keep service.ts transaction construction, contract ABI/runtime, approved deployments and backend authorization protocols unchanged unless a concrete dependency defect requires escalation. Connecting a wallet must not enable unapproved contract writes.
8. Configure the existing public project ID without committing its value. Document origin allowlist requirements and required build-time environment variable. Local read-only relay/QR verification is authorized; connecting/signing a real wallet or changing external project settings needs the user's secure flow.

## Acceptance

Run existing aggregate web tests, TypeScript and production build. Add meaningful boundary tests for explicit/lazy initialization, injected parity, missing configuration, rejected/cancelled connection, correct Sepolia session establishment, remote disconnect, old event/promise rejection, repeated attempts, connector changes during signature preparation and journal waits, and unchanged unavailable deployment state. Independent tests must include stale account/chain/provider races and use actual production abstractions, not copies of implementation.

Browser QA on the running candidate: desktop/mobile connection choices and layout, keyboard/focus, connect/error/retry/disconnect states, approved existing injected fixture, actual configured QR modal rendering and cancellation if relay access permits. User wallet pairing is a separate explicit user action; do not fabricate a live connected session or transaction. Record failed, blocked and unrun checks. No contract rerun is needed unless contract files change.

Keep detailed evidence in ignored artifacts/walletconnect-20261007/. Builder owns edit/test/repair, package.json and lockfile. No other writer in this worktree until handed back. Root may coordinate browser tests after the candidate is frozen. No child agents or agent subprocesses from builders. Usage telemetry unavailable is recorded unknown.
