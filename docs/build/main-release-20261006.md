# Uppercase headings and main release

Current status: source candidate prepared; final build, browser checks and independent review pending. User explicitly authorized uppercase H1s and a push to main, including the existing automatic website deployment. No on-chain deployment, funds movement or ownership action is authorized.

Baseline: `design/artwork-first-20261006` at `1e7c9ffaebc99d5611a29dbeea23d40ea39fcb0c`, clean. Fresh `origin/main` is `2bb586e798cfe5bf797965657954a1f2161f461f`, an ancestor with no competing commits. No open PR. Main release includes the previously implemented design and source hardening. Contract and API security files are unchanged from reviewed `ba09ad50`.

H1s now render uppercase through the shared CSS rule, retaining Sixtyfour, accessible text and existing scramble/reduced-motion handling.

Release dependency checks reproduced five previous advisories, including critical test-only Tinypool and high nested PostCSS. Bounded R1 maintenance upgrades Vitest to 4.1.11, retains Vite 7.3.6 through an override and overrides Next's PostCSS to patched 8.5.29. No direct application runtime version changed, no assertions were weakened and test configuration is unchanged. The PostCSS override requires continued maintenance when Next updates. Initial npm installation failed; a Vite 8 resolution then failed TSX parsing, and stale generated dependencies retained old PostCSS. Final clean regeneration and standard npm ci succeeded. Failed attempts remain in artifacts rather than being counted as passing.

Observed so far: standard npm ci, all 124 web tests, npm audit with zero findings, valid npm dependency tree, and whitespace validation pass. Contract build is within the EIP-170 runtime size limit, 21,688 bytes. All 50 contract tests pass, including three fuzz tests at 1,024 runs each. Existing Solidity lint warnings are retained.

Acceptance: production build, responsive uppercase/font checks on 14 routes at 320/390/768/1440, existing pack and control behavior, empty/single/multiple/expired/exhausted discovery states, independent final review. Then normal fast-forward main push, remote CI/deployment verification and live browser smoke checks. Do not force-push or bypass branch rules.

The published experience remains a disclosed browser demo. Contract timeout fairness, owner-dependent recovery/settlement, deployed configuration, funding and legal readiness remain separate unresolved operational/policy work for real-value use. This release does not update deployed contract bytecode or establish launch readiness.

Evidence: ignored `artifacts/main-release-20261006/`. Dependency owner was configured Sol Medium; independent release review uses Astra High. Model usage/cost telemetry is unknown.
