# Repository cleanup and portable verification

This R1 maintenance slice follows admission and fee integration. It implements the user's repository-wide cleanup request without changing financial policy, wallet authorization, branding, user assets or historical terms.

## Observed problems

- `seller-reader.integration.test.ts` invokes Anvil and compiled contract artifacts in the ordinary web suite, but the web CI job does not install Foundry or build contracts. Other chain suites use an explicit integration switch.
- Browser fixtures and a WalletConnect accessibility script contain this machine's Playwright package and browser-cache paths. Another checkout cannot run these checks with documented package installation alone.
- The repository retains older presentation components and fixture-only domain helpers. Some are still imported, including `OnChainStatus` by Rules and Profile and pack types by the active membership/cards. An import-graph check must establish which files are unused before removal.

## Contract for the implementation owner

Use one isolated Sol owner, with no children. First inspect the integrated revision and actual import graph. Remove only proven unused application code, associated obsolete selectors and tests of the removed implementation. Preserve meaningful behavior coverage against the active workflows. Keep all supplied assets, notices, licenses, v2 historical terms and public execution evidence.

Make the default unit suite independent of Anvil. Keep opt-in chain integration explicit and add a dedicated CI job that installs the existing pinned toolchains, builds contract fixtures and runs those suites. Do not silently skip the required chain lane at release. Keep a separate documented browser acceptance command with portable Playwright installation and optional explicit executable override. Root owns package and lockfile changes. Select exact versions from installed/current primary-source evidence; do not upgrade unrelated packages.

Document the shortest commands for unit, chain, browser, typecheck, production build and contract regression/fuzz checks. Link current engineering/release documentation from one index and clearly identify superseded reports. Do not delete history merely to reduce file count. CI uses read-only repository permissions and no persisted checkout credentials unless an existing job demonstrably needs them.

## Acceptance

- Application builds with no references to deleted code and active user journeys retain coverage.
- Default unit suite succeeds without Anvil available, and the separately enabled chain suite actually executes.
- A browser test runs using the documented portable package/executable configuration, with no `/home/tx` paths in versioned test code.
- Dependency and lockfile agree, relevant aggregate tests pass, and independent Astra review inspects the actual candidate.
- No secrets, generated caches or transient browser artifacts enter the committed source. No on-chain, publication or infrastructure actions occur in this slice.

The source mapping and implementation are pending. This document is a bounded work contract, not evidence that cleanup has happened.

## Tooling decision

Root pinned `playwright` 1.63.0 as a development dependency after checking the npm registry and official [library documentation](https://playwright.dev/docs/api/class-playwright) and [browser installation documentation](https://playwright.dev/docs/browsers). This matches the installed Chromium revision1243 and Firefox1543; the former fixture used Playwright1.50.1 against a different browser revision. Installation changed only the two Playwright package entries and their lock records. Browser binaries remain outside version control. The implementation owner should import this package normally and honor `CHROMIUM_EXECUTABLE` only as an optional explicit override.

The installed Forge1.5.1 formatter was observed removing braces around a multi-statement inline `if`, changing a new test's control flow. The production formatting diff was inspected and had no such change. Test fixtures were restored with explicit multiline blocks. Root fetched the official [Foundry1.8.5 release](https://github.com/foundry-rs/foundry/releases/tag/v1.8.5), verified its published SHA256 and GitHub attestation, and confirmed its formatter preserves that reproduction. The isolated binaries are under the task artifact directory; no global installation changed. Pin CI/tooling to1.8.5 and run final deterministic checks with that version. Keep Solc0.8.24, existing optimizer settings and EVM target unchanged.
