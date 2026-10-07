# Aikido finding 50054364

Aikido reported five shell-template injection patterns in the vendored OpenZeppelin gas-report and storage-layout composite actions. These patterns are unsafe if those actions receive hostile input. The report does not establish an active LABx pipeline compromise.

## Reachability and change

At `23d29c0`, LABx had one root workflow, `.github/workflows/ci.yml`. It called neither composite action nor any other path under `contracts/lib/openzeppelin-contracts/.github`. The only callers were OpenZeppelin's bundled nested workflows. GitHub discovers workflows in the repository root's `.github/workflows` directory, so those nested workflows were inactive here. Foundry imports Solidity through the configured remappings and does not run this metadata.

The OpenZeppelin directory is a tracked vendored snapshot, not a Git submodule. Its package metadata declares version 5.2.0 and the upstream repository; it does not record an exact upstream commit. This change removes its 14 unused GitHub metadata files, including the unsafe actions and their inactive callers. It preserves the library's Solidity, package metadata, license and documentation. LABx's active CI is unchanged.

Removing only the two flagged action files would leave broken references in the bundled upstream workflow. Patching only the five highlighted lines would also leave direct shell interpolation in their download steps. Removing the unused upstream automation avoids maintaining an unnecessary local action fork.

This is a scoped cleanup of unreachable automation, not a claim that all CI injection risks have been audited or that Aikido has rescanned the published revision. No vendored action or hostile input was executed against GitHub, production or a shared runner. The Aikido issue should be rechecked after the reviewed commit is published.

## Verification and maintenance

Compare the complete tracked inventory before and after removal, confirm no LABx caller referenced the removed directory, and verify that all Solidity/compiler inputs and the active CI are unchanged. Run the existing Foundry build and regression checks on the candidate. Independent release review must assess the removal and its evidence.

Future dependency refreshes should preserve this exclusion or explicitly review any reintroduced automation before it can be called. Ownership of that check remains with the LABx maintainer. Do not exclude the whole dependency from security scanning; its Solidity remains relevant.

GitHub documents the discovery location in [Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax) and the underlying risk in [Script injections](https://docs.github.com/en/actions/concepts/security/script-injections). If an upstream action is ever needed, apply [GitHub's secure-use guidance](https://docs.github.com/en/actions/reference/security/secure-use) and review its complete input path before enabling it.
