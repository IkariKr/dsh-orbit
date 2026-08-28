# Contributing

DSH Orbit is intended to remain a small compatibility and deployment layer around DeepSeek Harness. Changes should preserve that boundary.

## Before opening a pull request

1. Check whether upstream DSH already provides the capability. Prefer upstream behavior over a local patch.
2. Keep compatibility changes scoped to explicit DSH versions or source layouts.
3. Add tests for success and failure paths.
4. Do not add deployment-specific addresses, credentials, tokens, certificate material, or user data.
5. Run:

```sh
npm run check
```

## Security-sensitive changes

Changes to any of the following require negative authorization tests:

- privileged DSH RPC access;
- trusted proxy detection;
- identity-provider headers;
- same-origin checks;
- secret handling;
- reverse-proxy examples.

A successful request is not sufficient evidence. Tests should also prove that an unauthenticated, cross-site, or spoofed request is rejected where applicable.

## Compatibility changes

When adding support for a new DSH version:

- add the version to the compatibility registry;
- document the tested version in `docs/compatibility.md`;
- use exact source-shape checks in the patcher;
- fail when an expected source fragment is missing or duplicated;
- avoid broad search-and-replace rules that may patch unrelated code.

## Commit style

Keep commits focused on one logical change. Use clear imperative subjects, for example:

```text
Add compatibility profile for DSH 0.1.2
Harden proxy assertion handling
Document candidate upgrade workflow
```
