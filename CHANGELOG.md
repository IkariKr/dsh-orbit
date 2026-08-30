# Changelog

All notable changes to DSH Orbit are documented here.

The project follows Semantic Versioning once the public API and deployment contract stabilize. Early `0.x` releases may change as DeepSeek Harness evolves.

## 0.2.6 - 2026-08-30

### Fixed

- the dsh-ssh bundle verifier now requires the complete expected helper block — every security predicate included — to appear exactly once, byte for byte; removing or weakening the HTTPS, proxy-secret, cross-site, origin, or host checks fails closed, on top of the existing structural checks (partial patches, missing or duplicated gates, constant and version mismatches, idempotent re-patch);
- documentation alignment: `docs/upgrade.md` states the `terminalFence` vs `terminalPtty` semantics for v0.2.5+, the CLI usage lists the `DSH_ORBIT_PATCH_DSH_SSH` enable flag, and `UPGRADE_CHECK_ORDER` matches the real verification sequence.

## 0.2.5 - 2026-08-30

### Fixed

- the live terminal fence smoke now runs only when the dsh-ssh fence patch is enabled (`DSH_ORBIT_PATCH_DSH_SSH=1`); disabled deployments report `terminalFence: not_run` without running the smoke, and an enabled-but-failing fence blocks promotion eligibility;
- the dsh-ssh patched-bundle verifier now requires exactly one helper declaration, exactly three patched gates, zero remaining unpatched gates, the exact configured public host and proxy auth file constants, and an exact plugin version — the idempotent re-patch path runs the full verifier, so any partial, tampered, missing, or duplicated fragment fails closed;
- the compatibility report now separates `terminalFence` (automated live authorization result) from `terminalPtty` (actual PTY runtime evidence, recorded from the Stage 7 manual acceptance); a fence pass alone is not PTY runtime evidence;
- `DSH_SSH_PLUGIN_ROOT` and `DSH_SSH_PLUGIN_VERSION` are first-class upgrade configuration, propagated into the candidate container through the compose override when the patch is enabled, and documented in the CLI usage and README.

## 0.2.4 - 2026-08-30

### Added

- profile-local compatibility patch for the `@linxin666/dsh-ssh` terminal fence (`DSH_ORBIT_PATCH_DSH_SSH=1`): remote PTY terminals are admitted only through the authenticated Orbit proxy path — exact public host, HTTPS forwarding, gateway-injected internal proxy secret, same-origin, non-cross-site — while loopback keeps its original path and every other denial stays intact; the patch is version-pinned (`0.3.2`) and fails closed on any source drift;
- live terminal authorization smoke (`npm run smoke:terminal`) with a positive control and five denial cases against the terminal upgrade endpoint, wired into the candidate verification sequence (`terminalPtty` is now an automated check);
- documentation of `DSH_UPGRADE_GATEWAY_SERVICE`, `DSH_UPGRADE_GATEWAY_CERT_TARGET`, `DSH_UPGRADE_GATEWAY_KEY_TARGET`, `DSH_ORBIT_PATCH_DSH_SSH`, `DSH_SSH_PLUGIN_ROOT`, and `DSH_SSH_PLUGIN_VERSION` in the README and CLI usage.

## 0.2.3 - 2026-08-30

### Fixed

- the runner's default gateway identity certificate targets now match the public example compose (`/run/certs/fullchain.pem` and `/run/certs/privkey.pem` on the `caddy` service), are tunable through `DSH_UPGRADE_GATEWAY_SERVICE`, `DSH_UPGRADE_GATEWAY_CERT_TARGET`, and `DSH_UPGRADE_GATEWAY_KEY_TARGET`, and fail closed when the base compose gateway does not already mount a certificate at the configured targets;
- the `verify` subcommand now passes the per-run identity certificate (path and content) into the verification sequence, so runner HTTPS checks and the smoke suites trust the per-run certificate without manual `NODE_EXTRA_CA_CERTS`;
- the compatibility report annotates the not-implemented `longLivedTransport` and `terminalPtty` checks with the Stage 7 manual acceptance evidence recorded in the release attestation.

## 0.2.2 - 2026-08-30

### Fixed

- the candidate endpoint is now bound to the candidate stack by identity: the runner generates a per-run gateway identity certificate, mounts it into the candidate gateway through the compose override, and requires `DSH_SMOKE_URL` to present exactly that certificate (TLS fingerprint probe) before any check runs — smoke results against an unrelated deployment can no longer produce a passing candidate;
- the resolved compose configuration must publish the candidate port on loopback (`127.0.0.1` or `::1`); all-interface bindings fail closed;
- snapshot manifests bind the optional `candidateDshVersion` to the snapshot request;
- the runner's own HTTP checks and the smoke suites trust the per-run identity certificate (`NODE_EXTRA_CA_CERTS`), and the runner documents its OpenSSL requirement;
- the per-run identity files are ownership-adjusted for the gateway user parsed from the resolved compose configuration.

## 0.2.1 - 2026-08-29

### Fixed

- the candidate upgrade runner now binds its configuration to the actual Docker execution: a compose override carries the candidate image, copied data and workspace roots, and isolated loopback port, and the resolved `docker compose config` is verified against the candidate specification — plus a per-run token probe on the started stack — before any check runs;
- snapshot manifests are bound to the snapshot request: any pre-existing manifest is removed before the hook runs, and after a zero exit the manifest must match the requested snapshot id, data root, Orbit revision, and data-producing DSH version, with a creation timestamp not older than the request;
- `verify` and `report` can no longer print `eligible for manual promotion`: reports separate `compatibility` from `promotion readiness`, promotion readiness is evaluated only for a full candidate run, and a persisted snapshot failure permanently denies eligibility including across report regeneration;
- promotion eligibility requires the exact candidate Orbit revision and compatibility profile plus the exact baseline rollback target (image, Orbit revision, DSH version);
- the authorization smoke treats 5xx responses as failed cases rather than authorization denials;
- a snapshot manifest may record the optional `candidateDshVersion` alongside the version that produced the data.

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
