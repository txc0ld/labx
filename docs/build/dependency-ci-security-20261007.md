# Dependency and CI security disposition (2026-10-07)

## `ws` 8.x

At base revision `847db2fbec2bb88662a4cde5f492f5b53fe8009e`, a clean `npm ci` installed these copies:

- `node_modules/ws` at 8.21.0, shared by `viem`, `isows`, and the optional Solana subscription packages below `@reown/appkit`.
- `node_modules/@walletconnect/jsonrpc-ws-connection/node_modules/ws` at 7.5.13 for the WalletConnect JSON-RPC connection.

`npm audit --json` reported zero vulnerabilities at that revision. This does not resolve Aikido finding 50054339: [GHSA-73jw-fp74-p77x](https://github.com/advisories/GHSA-73jw-fp74-p77x) describes CVE-2026-62389 as memory exhaustion through incomplete fragmented WebSocket messages in `ws` versions before 8.21.1. The [`ws` 8.21.1 release](https://github.com/websockets/ws/releases/tag/8.21.1) counts empty fragments toward the limit and reduces the default `maxBufferedChunks` and `maxFragments` values.

The installed 8.21.0 source set both client and server defaults to 1,048,576 buffered chunks and 131,072 message fragments. The selected 8.21.3 source sets them to 262,144 and 16,384, respectively, and counts every fragment. See the upstream [`8.21.0...8.21.3` comparison](https://github.com/websockets/ws/compare/8.21.0...8.21.3) and the [`ws` 8.21.3 release](https://github.com/websockets/ws/releases/tag/8.21.3).

The package override `"ws@^8": "8.21.3"` limits the change to the 8.x line. A clean install retains the nested 7.5.13 backport and installs 8.21.3 at the root. The application imports `viem` and initializes WalletConnect, but its own transports use `http`; no application source imports `ws` or selects Viem's `webSocket` transport. The dependency graph proves that the package is installed. It does not by itself prove that a remotely reachable production path instantiates the 8.x implementation.

The lockfile changes only the root `node_modules/ws` version, tarball URL, and integrity hash. It does not upgrade any parent package. No Aikido finding was dismissed, and the unrelated Handlebars and VRF-key-hash dispositions were not changed.

## CI action pins

Each moving major tag in `.github/workflows/ci.yml` is pinned to the full commit returned by `git ls-remote` against the official upstream repository on 2026-10-07. The lookup requested both the tag ref and its peeled `^{}` ref. All three tags were lightweight, so upstream returned the commit directly and no separate peeled ref.

| Action | Retained tag | Pinned commit | Inspected execution metadata |
| --- | --- | --- | --- |
| [`actions/checkout`](https://github.com/actions/checkout/tree/11d5960a326750d5838078e36cf38b85af677262) | `v4` | `11d5960a326750d5838078e36cf38b85af677262` | Node 20; `dist/index.js` for main and post |
| [`actions/setup-node`](https://github.com/actions/setup-node/tree/49933ea5288caeca8642d1e84afbd3f7d6820020) | `v4` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | Node 20; `dist/setup/index.js` for main and `dist/cache-save/index.js` for post |
| [`foundry-rs/foundry-toolchain`](https://github.com/foundry-rs/foundry-toolchain/tree/908c540300062bd5a7e473851cdb4282204cee09) | `v1` | `908c540300062bd5a7e473851cdb4282204cee09` | Node 24; `dist/index.js` for main and `dist/save/index.js` for post |

The workflow retains read-only repository permissions, `persist-credentials: false`, Node 22, Foundry v1.8.5, the existing cache inputs, and the browser job's 20-minute timeout and flags. The chain integration job also exports `RUN_INDEPENDENT_WALLET_REVIEW_REPAIRS=1` so its four independent wallet-review regression cases run with the existing chain suite.
