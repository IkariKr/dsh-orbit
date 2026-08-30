# ADR-0001: Third-party plugin boundary

Status: Accepted (2026-08-30)

## Context

DSH Orbit ships production deployments that include third-party DSH plugins. Domain experience showed two classes of issues: (a) issues caused by DSH core itself, and (b) issues caused by third-party plugin behavior (for example the `@linxin666/dsh-client-ui-skin-center` background-reset-on-reload behavior, and the `@linxin666/dsh-desktop-launcher` `xdg-open` failure in headless containers). Maintaining plugin-specific compatibility logic in Orbit core proved costly and unbounded.

## Decision

**Orbit understands DSH, not the DSH plugin ecosystem.**

- Orbit core supports and integrates with DeepSeek Harness itself.
- Orbit core does not patch, fork, version-pin, adapt, or maintain compatibility logic for third-party DSH plugins.
- DSH-core issues may be reported upstream or contributed as a PR; temporary fail-closed DSH compatibility patches are allowed only with explicit exit conditions and an upstream-first posture.
- Third-party plugin issues are outside Orbit's responsibility; downstream operators decide about plugin upgrades and acceptance on their own.
- Orbit provides generic infrastructure primitives only, with no plugin-specific conditionals.
- Existing plugin-specific code (the `@linxin666/dsh-ssh` terminal fence patch and related configuration, smoke, and tests) is legacy debt: freeze-only, documented, and removed once DSH provides a general trusted-client / authenticated-proxy capability.

## Consequences

- The legacy `dsh-ssh` compatibility layer remains functional for existing production deployments but receives no new features.
- New features (including v0.3 registry, capabilities, and fleet designs) must not reference third-party plugin names or versions.
- Documentation records unsupported third-party behavior instead of adding substitute implementations.

## Migration conditions (removal of the legacy `dsh-ssh` logic)

The plugin-specific code (`src/plugin-patch-dsh-ssh.mjs`, `DSH_ORBIT_PATCH_DSH_SSH`, `DSH_SSH_PLUGIN_ROOT`, `DSH_SSH_PLUGIN_VERSION`, the dsh-ssh source matcher, the terminal plugin smoke, and their tests) is removed when either:

1. upstream DSH provides a sufficiently generic trusted-client / authenticated-proxy capability (an official remote-administration path with equivalent security properties), and the deployment has migrated to it; or
2. the maintainers review and accept this boundary change with the same fail-closed posture, and the affected production deployments have an operator-approved alternative.

Until then the code stays freeze-only: no new plugin-specific conditionals, no extension of the original exported surface.