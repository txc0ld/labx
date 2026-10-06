# Revised LABx splash release

## Scope and authority

R1. The user accepted the revised film and requested "upload it" after asking to assign it as the website splash. Release the approved V2 film and its website splash integration to LABx production. This authorization covers this presentation release, not the separate unshipped financial workflow/contract changes, an on-chain deployment or any wallet operation.

Base: origin/main `024f4d983d9c6d7b6a579b8da9fbc2fecbae00b5`. Target: GitHub `txc0ld/labx` main and Vercel `tx-build/labx`, project `prj_y7HPTXvtKILlhNLlf2BFrlDaibnt`, production alias `https://labx-two.vercel.app`. Preserve concurrent work and use a normal fast-forward update after all gates; no force push. Recheck remote main before publishing and reconcile/reverify if it moved.

## Contract

Copy the reviewed BrandSplash component, CSS, eligibility helper/tests and optimized V2 wide/tall MP4 plus poster from local `c5baec7e0ff5294982f9d47c743b89b0eb35d930`, retaining byte identity for media. Mount in the existing main layout with the smallest compatible change. Include the minimal privacy-page correction describing the intro-shown session flag and its lifetime. Do not copy the unreleased financial-journal disclosure. No package/lockfile changes or financial/API/contract edits. Preserve current production page behavior and navigation.

The intro explains memberships, bonus NFT raffle entries and partner discounts. It starts muted once per eligible browser session, provides Sound/Skip and Escape, auto-dismisses on completion/failure, restores focus and scrolling, respects reduced motion and data saving, bypasses direct routes/hash navigation, and loads only the correct orientation asset. The 5% offers retain redemption-coming-soon disclosure. No automatic wallet interaction or financial availability claim.

## Ownership and gates

Root Astra owns this contract, integration/release and evidence. Sol owns only the bounded transplant in an isolated worktree and its edit/check loop. A fresh Astra reviewer inspects the actual release diff and inherited main callers before publication. Root verifies production build, existing tests, TypeScript and splash browser behavior against the release candidate. Existing media decode evidence is reusable only after all file hashes match.

After the scoped candidate passes: commit, recheck upstream, push the tested fast-forward candidate to main under this user authorization, observe GitHub CI and automatic Vercel production deployment, and verify the public alias serves the exact media and intended interaction. Report the exact commit/deployment URL and observed checks. No success claim on push alone. Keep evidence under `artifacts/splash-release-20261007` and exclude secrets/environment files.
