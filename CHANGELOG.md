# Changelog

All notable changes to DSH Orbit are documented here.

The project follows Semantic Versioning once the public API and deployment contract stabilize. Early `0.x` releases may change as DeepSeek Harness evolves.

## 0.1.1 - 2026-08-28

### Added

- existing-session resume smoke test for candidate upgrades, including a clear diagnostic for the upstream `agent-presets` unscoped-context failure;
- upgrade compatibility guidance requiring a pre-upgrade session resume check on copied data.

### Fixed

- pass `DSH_PUBLIC_HOST` to the upstream `dsh web --trusted-host` option so authenticated reverse-proxy requests can reach plugin routes protected by DSH's browser-trust fence, including lazy-loaded UI bundles.

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
