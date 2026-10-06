# Uppercase headings and main release

Current status: pre-push acceptance and independent review PASS for application source `1c60729001172097dc1048840e40ecc26309b421`. This closeout changes documentation only. User explicitly authorized uppercase H1s and a push to main, including the existing automatic website deployment. No on-chain deployment, funds movement or ownership action is authorized.

Baseline: `design/artwork-first-20261006` at `1e7c9ffaebc99d5611a29dbeea23d40ea39fcb0c`, clean. Fresh `origin/main` is `2bb586e798cfe5bf797965657954a1f2161f461f`, an ancestor with no competing commits. No open PR. Main release includes the previously implemented design and source hardening. Contract and API security files are unchanged from reviewed `ba09ad50`.

H1s now render uppercase through the shared CSS rule, retaining Sixtyfour, accessible text and existing scramble/reduced-motion handling.

Release dependency checks reproduced five previous advisories, including critical test-only Tinypool and high nested PostCSS. Bounded R1 maintenance upgrades Vitest to 4.1.11, retains Vite 7.3.6 through an override and overrides Next's PostCSS to patched 8.5.29. No direct application runtime version changed, no assertions were weakened and test configuration is unchanged. The PostCSS override requires continued maintenance when Next updates. Initial npm installation failed; a Vite 8 resolution then failed TSX parsing, and stale generated dependencies retained old PostCSS. Final clean regeneration and standard npm ci succeeded. Failed attempts remain in artifacts rather than being counted as passing.

Observed pre-push checks: standard npm ci, all 124 web tests, npm audit with zero findings, valid npm dependency tree, and whitespace validation pass. Contract build is within the EIP-170 runtime size limit, 21,688 bytes. All 50 contract tests pass, including three fuzz tests at 1,024 runs each. Existing Solidity lint warnings are retained.

Acceptance: production build, responsive uppercase/font checks on 14 routes at 320/390/768/1440, existing pack and control behavior, empty/single/multiple/expired/exhausted discovery states, independent final review. Then normal fast-forward main push, remote CI/deployment verification and live browser smoke checks. Do not force-push or bypass branch rules.

The published experience remains a disclosed browser demo. Contract timeout fairness, owner-dependent recovery/settlement, deployed configuration, funding and legal readiness remain separate unresolved operational/policy work for real-value use. This release does not update deployed contract bytecode or establish launch readiness.

Evidence: ignored `artifacts/main-release-20261006/`. Dependency owner was configured Sol Medium; independent release review uses Astra High. Model usage/cost telemetry is unknown.

## Final local acceptance

Production build exits 0, including TypeScript checks. The existing ox/viem dynamic-dependency warning remains. Headless Chromium verifies 14 routes at 320/390/768/1440, 56 combinations, with actual uppercase Sixtyfour rendering, Basetica elsewhere, no clipped headings or horizontal overflow, and scramble/reduced-motion behavior. Separate controls checks pass 24 page/viewport combinations plus filters, navigation, keyboard, inputs, disabled states and agreement gating. Pack checks cover responsive/hover bounds, native keyboard selection, fee-inclusive totals, sold-out/closed states and live reduced-motion changes. Discovery checks pass zero/one/multiple listings, direct routes/reload/back, expiry/exhaustion, all five footer links and mobile wrapping. All final browser lanes report zero page errors. No wallet connection, accepted agreements or successful purchase action was performed.

An initial discovery harness check expected mixed-case status while the existing UI renders uppercase. The case-insensitive corrected check passed without an application change; original failure is retained in `discovery-initial-case-mismatch.txt`.

Independent Astra High review PASS for source `1c60729`, with no blocking finding in the website-demo release scope. Full verdict and evidence: `artifacts/main-release-20261006/review.md`. Physical-device/Safari checks and real-value operation remain unverified. Remote CI, Vercel alias association and live smoke evidence are captured after the authorized push under the same artifact directory; they are not inferred from local checks.
