# Third-party compatibility debt

Boundary principle: see `docs/architecture.md` and `docs/adr/0001-third-party-plugin-boundary.md`.

This document is the inventory of every current third-party plugin coupling point in DSH Orbit, the status of each, and the exit conditions. It exists so the debt stays visible and finite. Nothing here is being removed while production depends on it.

## Current coupling points (all legacy debt)

| # | Coupling | Location | Status |
| --- | --- | --- | --- |
| 1 | `@linxin666/dsh-ssh` bundle patch (exact source matcher, version pin `0.3.2`, helper injection) | `src/plugin-patch-dsh-ssh.mjs` | legacy, freeze-only |
| 2 | plugin-enable flag and plugin paths in the container patcher | `bin/dsh-orbit-patch.mjs` (`DSH_ORBIT_PATCH_DSH_SSH`, default `…/@linxin666/dsh-ssh` path) | legacy, freeze-only |
| 3 | plugin config knobs and candidate-override propagation | `src/upgrade-runner.mjs` (`sshPatchEnabled`, `sshPluginRoot`, `sshPluginVersion`) | legacy, freeze-only |
| 4 | plugin-specific live smoke on the terminal upgrade endpoint | `scripts/smoke-terminal.mjs` | legacy, freeze-only |
| 5 | report check driven by the plugin smoke | `src/compatibility-report.mjs` (`terminalFence`) + runner sequence | legacy, freeze-only |
| 6 | tests pinned to the plugin behavior | `test/helpers/ssh-fence-fixture.mjs`, `test/plugin-patch-dsh-ssh.test.mjs`, `test/upgrade-cli-verify.test.mjs`, `test/upgrade-runner.test.mjs` | legacy, freeze-only |
| 7 | documentation referencing the plugin | `docs/upgrade.md`, `README.md`; historical `docs/release-attestations/*` (records, keep) | legacy references; withdrawal notes added |

Rules for these items, taken from ADR-0001:

- freeze-only: no new features, no new plugin-specific conditionals, no extension of the exported surface;
- no removal while production depends on them (any removal requires the migration conditions below and an operator-approved alternative).

## Migration conditions (removal)

Removal happens when either:

1. upstream DSH provides a sufficiently generic trusted-client / authenticated-proxy capability (an official remote-administration path with equivalent security properties) and the deployment has migrated to it; or
2. maintainers accept the boundary change and affected production deployments have an operator-approved alternative.

No future work may extend this debt: v0.3 registry, capabilities, and fleet designs must not reference third-party plugin names, versions, or paths (verified: `docs/rfc/0001–0004` contain no third-party plugin names).

## Downstream decisions recorded (no Orbit action taken)

- **`@linxin666/dsh-client-ui-skin-center@0.3.2` settings reset on reload** — diagnosed as plugin behavior (client forwards default legacy `skin-background` values into the v2 active document on page load; DSH core settings, Orbit remote settings, and the persistent volume all work correctly). Orbit takes no fix, patch, issue, or PR. Downstream operators may upgrade or configure the plugin themselves and accept it on their own.
- **"Open config file" (`settings.openDocument`) failing with `spawn xdg-open ENOENT` in the headless container** — the handler is provided by the `@linxin666/dsh-desktop-launcher` plugin (no `xdg-open` handler in the DSH core libs). If further evidence shows the failure instead stems from a DSH core capability assumption, an upstream issue/PR is allowed; current evidence points to the plugin, so Orbit documents this as *unsupported third-party behavior in a headless deployment* and adds no substitute implementation.