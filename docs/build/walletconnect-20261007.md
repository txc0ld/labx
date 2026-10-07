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

## Approved dependency and lifecycle adjustments

Root approved two exact direct dependencies: `@walletconnect/ethereum-provider@2.25.0` and `@reown/appkit@1.8.19`. The provider's built-in QR adapter does not expose analytics/onramp/swap controls. The separate official AppKit core modal uses `manualWCControl`, the same UniversalProvider, and its URI-based basic view. That view renders wallet/deep-link choices on mobile and QR plus wallet choices on desktop. AppKit has no independent application wallet authority.

Root also approved the narrow `@walletconnect/universal-provider: 2.25.0` override. AppKit pins 2.23.7, which creates duplicate incompatible provider classes and lacks later relay fixes. The upstream [core changelog](https://github.com/WalletConnect/walletconnect-monorepo/blob/v2.0/packages/core/CHANGELOG.md) documents the 2.23.10 plaintext TYPE_2 relay rejection in PR7255 and the 2.23.9 relayer reconnection/memory fix in PR7206. Downgrading to 2.23.7 was investigated and rejected. Final `npm ls` resolves the relevant EthereumProvider, UniversalProvider, SignClient and Core packages to 2.25.0. Independent review must inspect the override and modal lifecycle.

The SDK's `abortPairingAttempt()` is a no-op. Each attempt therefore uses isolated in-memory storage and a unique storage prefix. No WalletConnect session is restored after reload. Cancellation invalidates the app session immediately, unsubscribes modal/URI listeners and retires the provider. Cleanup disconnects its session and pairings, stops the SDK heartbeat, closes its relay transport and clears storage, with deadlines. A late approval is revoked by its own session topic without touching the next modal or wallet. SDK global core caching is disabled through the supported `DISABLE_GLOBAL_CORE=true` build setting.

The SDK has no full provider-disposal or pending-approval cancellation API. The app allows at most one unfinished SDK initialization and three unresolved approval promises per page, and serializes modal attempts. After the third unresolved cancellation it asks the user to wait for those requests to expire or reload. Browser wallet remains available. Internal SDK approval timers may live until their finite timeout; this is not represented as complete SDK disposal. No stale approval is attached to the wallet authority.

Rollback is removal of this frontend slice and its two dependencies/override. No backend, contract, deployment, journal format or stored app data migration is required. Existing submitted transaction receipt recovery is unchanged.

## Configuration and browser handoff

Set `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` to the public 32-character project identifier in the build environment. Rebuild after changing it. Its value remains only in ignored `web/.env.local` here. Missing/invalid configuration disables only WalletConnect. Local chain31337 fixtures also disable only WalletConnect.

The Reown project must allow the exact production and preview origins used by the browser. Local QR verification requires the relevant localhost/127.0.0.1 development origin to be permitted as well. Project settings were not changed. Pairing a real wallet or signing remains a user action. The metadata URL follows the active browser origin.

Run the built candidate from `web` using `npm run start -- --hostname 127.0.0.1 --port 3127`. Use `/profile` for connection controls. For injected parity, install an EIP-1193 fixture with the browser's init-script API before navigation. Return `0xaa36a7` for `eth_chainId`, a fixed account array for `eth_accounts` and `eth_requestAccounts`, and null for `wallet_switchEthereumChain`. Implement `on`/`removeListener` and fail any signing or transaction method. The application stays unavailable for contract writes because APPROVED_DEPLOYMENTS remains empty. The existing local31337 fixture setup can also be used in a separate development server with the existing local manifest variables.

## Builder evidence

Designated critical builder routing is GPT-6 Astra High per configured role. Runtime usage telemetry is unavailable and recorded unknown. Evidence is in ignored `artifacts/walletconnect-20261007/`; logs contain no project ID value.

- Existing aggregate run after the session boundary change: exit0, 150 passed and29 skipped.
- Final aggregate: exit0, 171 passed and29 skipped. TypeScript: exit0. Dependency audit: exit0, zero vulnerabilities. Build and supporting results are recorded in `test.log`, `typecheck.log`, `build.log`, `audit.json`, `dependencies.log` and `checks.tsv`.
- Chain/browser integration suites are opt-in and skipped by the aggregate command. No contract files changed and no public-chain operations were performed.
- The build reports an existing viem/ox dynamic-dependency warning through the backend receipt import path. Compilation and route generation complete successfully.
- Builder tests cover connector laziness, injected parity, local fixtures, configuration failure, cancellation/rejection/expiry, Sepolia validation, remote disconnection, stale initialization/events/refresh/signing/journal waits, disposal, repeated attempts and actual QR adapter cleanup with mocked external SDKs. Browser QA, independent verification and independent approval remain required before this candidate can be accepted.
