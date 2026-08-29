# Changelog

All notable changes to DSH Orbit are documented here.

The project follows Semantic Versioning once the public API and deployment contract stabilize. Early `0.x` releases may change as DeepSeek Harness evolves.

## 0.2.0 - 2026-08-29

### Added

- live authorization smoke suite (`npm run smoke:auth`) that proves the positive control and five negative authorization outcomes against a running deployment, with credential redaction and non-zero exit on any required mismatch;
- sanitized, reproducible compatibility report generation (`npm run report:compatibility`) with explicit `pass`/`fail`/`not_run` check states and a promotion-eligibility decision derived only from the recorded evidence;
- downstream snapshot contract with a portable reference hook (`examples/snapshot-hook-reference.sh`), strict machine-checkable manifests, timeout handling, and a promotion-readiness gate that denies promotion after any snapshot failure (`docs/snapshot-rollback.md`);
- candidate upgrade runner (`npm run upgrade -- preflight|candidate|verify|report`) that runs the production snapshot, builds without replacing the last known-good image, starts against copied data on an isolated endpoint, executes the deterministic verification sequence, stops fail-closed at the first required failure, and never promotes production automatically;
- scheduled upstream DSH watcher (`.github/workflows/upstream-watcher.yml`) that classifies newly published package versions against the compatibility registry without modifying it, with report artifacts and maintainer review guidance;
- `DSH_SMOKE_ORIGIN` for gateways that rewrite the `Host` header to a public authority differing from the smoke endpoint URL.

## 0.1.1 - 2026-08-29

### Added

- existing-session resume smoke test for candidate upgrades, including a clear diagnostic for the upstream `agent-presets` unscoped-context failure;
- upgrade compatibility guidance requiring a pre-upgrade session resume check on copied data;
- a manual `node-pty` repair helper for persisted profiles when an operator needs to rerun the automatic terminal runtime repair explicitly.

### Fixed

- pass `DSH_PUBLIC_HOST` to the upstream `dsh web --trusted-host` option so authenticated reverse-proxy requests can reach plugin routes protected by DSH's browser-trust fence, including lazy-loaded UI bundles;
- give the container `dsh` user an interactive Bash login shell and set `SHELL=/bin/bash`, avoiding terminal plugins resolving Alpine's default `/sbin/nologin` account shell;
- repair a missing `node-pty` native binding for persisted profiles on Alpine before DSH starts, using the bundled Node.js headers so the repair does not need to download headers at runtime.

## 0.1.0 - 2026-08-28

### Added

- initial public project structure;
- authenticated reverse-proxy compatibility patch for DSH `0.1.1-rc.2`;
- build-time and profile-runtime patch modes;
- fail-closed source-layout checks;
- Docker and reverse-proxy examples;
- compatibility, security, architecture, upgrade, and roadmap documentation;
- unit tests for patch application, idempotency, unsupported versions, and source mismatch handling;
- repository scan for common secret and site-specific data leaks;
- deterministic downstream runtime hooks with fail-closed execution;
- graceful DSH Web restart command for in-container maintenance;
- downstream production deployment pattern that separates public source from private state.
