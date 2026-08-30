# Upgrade guide

DeepSeek Harness is evolving quickly. Treat every upstream version change as a candidate deployment until its compatibility and data behavior have been verified.

## Recommended workflow

### 1. Keep the current production image

Use immutable versioned image tags. Do not overwrite the last known-good image tag during an upgrade.

Example naming:

```text
dsh-orbit:0.1.1-rc.2-orbit.1
dsh-orbit:0.1.2-orbit.1
```

### 2. Snapshot persistent data

Back up the DSH data directory before starting the candidate against production data. The snapshot hook contract in [Snapshot and rollback](snapshot-rollback.md) makes this step machine-checkable: a failed or incomplete snapshot denies promotion readiness.

Prefer testing with a copy of the data first. Upstream migrations can make image rollback insufficient on their own.

### 3. Add upstream compatibility intentionally

Update the DSH version only after reviewing the installed `dsh-client-connection` source shape.

If the existing patch still applies exactly, add the new version to `src/compatibility.mjs` and add a test case. If the source changed, implement a separate compatibility profile rather than weakening the existing matcher.

### 4. Build a candidate image

```sh
DSH_VERSION=<candidate> \
DSH_PUBLIC_HOST=dsh.example.com \
docker compose -f docker/compose.example.yaml build
```

The image build must fail if the global compatibility patch does not match.

### 5. Start with copied data

Run the candidate against a copied DSH data directory and use a non-production gateway port or isolated host.

The container is considered ready only after the profile-local patch has been applied and verified.

### 6. Run smoke tests

At minimum verify:

- the DSH web UI loads;
- a lazy-loaded plugin asset or route that uses the upstream browser-trust fence loads through the public host;
- `settings.describe` succeeds through the authenticated gateway;
- the response reports a writable settings provider when expected;
- a no-op `settings.mutate` succeeds on a safe namespace;
- at least one session created before the upgrade can be resumed and can re-select its current model;
- a request without the internal proxy secret is rejected;
- a cross-site request is rejected;
- a local proxy cannot spoof an identity-provider assertion header;
- WebSocket and long-running agent traffic still work;
- a sidebar terminal can open a PTY and run `dsh --version`, which also verifies the persisted profile's `node-pty` native binding for the candidate container.

For the existing-session check, run against copied candidate data rather than production data:

```sh
DSH_SMOKE_URL=https://candidate.example.com \
DSH_SMOKE_SESSION_ID=session-... \
npm run smoke:session
```

The smoke test reads the session's current model and re-selects that same model. This exercises the cold-resume path without intentionally changing the model choice. Use a session that predates the candidate DSH version; a newly created session does not validate upgrade compatibility.

If `dsh-better-sidebar` is installed but its Linux `node-pty` native binding is missing, repair the copied candidate data before promotion:

```sh
DSH_ORBIT_IMAGE=dsh-orbit:<candidate-tag> \
DSH_DATA_DIR=/path/to/copied/data \
sh scripts/repair-node-pty.sh
```

This is a manual fallback for the automatic startup repair included in Orbit `0.1.1`. It reuses the repair command and build toolchain already present in the selected Orbit image and writes the compiled native binding into the mounted profile data.

### 7. Promote and verify again

After the candidate passes, snapshot production data, switch the image tag, and repeat the smoke tests on the production path.

## Compatibility report

A candidate validation run is summarized in a sanitized, reproducible compatibility report. The report generator reads a structured evidence document and produces both a machine-readable JSON report (for CI artifacts, archival, and automated comparison) and a concise human-readable summary:

```sh
npm run report:compatibility -- \
  --input evidence.json \
  --json-out report.json
```

`--format json` switches the console output to JSON. `DSH_REPORT_REDACTIONS` optionally holds a JSON array of secret strings that are replaced with `[redacted]` inside check details.

### Status meanings

Every check has an explicit state; missing evidence is never treated as a pass:

- `pass` — the check ran and succeeded;
- `fail` — the check ran and failed;
- `not_run` — the check did not run in this validation round.

`globalPatch`, `profilePatch`, `runtimeReadiness`, `settingsRead`, `settingsNoopWrite`, `authorizationSmoke`, `sessionResume`, and `webPluginRoutes` are required. `longLivedTransport` is recorded when automated support exists.

> Note: the terminal fence checks below are legacy third-party compatibility debt for the
> `@linxin666/dsh-ssh` plugin (ADR-0001); they are freeze-only and will be removed when DSH
> provides a generic trusted-client / authenticated-proxy capability. See `docs/third-party-debt.md`.

Terminal evidence is split into two optional checks:

- `terminalFence` — automated since `0.2.5`: the live terminal authorization smoke (positive control plus unauthenticated, invalid-credential, unexpected-Origin, cross-site, and forged-assertion denials against the terminal upgrade endpoint) runs whenever the dsh-ssh fence is enabled (`DSH_ORBIT_PATCH_DSH_SSH=1`), and a failure blocks promotion eligibility. Disabled deployments record `not_run` and run nothing.
- `terminalPtty` — actual PTY runtime evidence. Currently recorded as `not_run`; the evidence comes from the Stage 7 manual acceptance in the release attestations. A `terminalFence` pass is authorization evidence only and must not be treated as `terminal.pty` runtime evidence by future fleet capability advertisement.

The report separates two outcomes:

- **`compatibility`** — did the candidate pass its checks? `pass` requires every required check to have passed and no tested check to have failed. A compatibility pass says nothing about identities or snapshots.
- **`promotion readiness`** — may an operator promote? Evaluated only for a full candidate run (`verify` reports `NOT EVALUATED`). Eligible requires all of: compatibility `pass`; the exact candidate Orbit revision and DSH compatibility profile recorded; the exact baseline (last known-good image, its Orbit revision, and its DSH version) recorded as the rollback target; and a completed snapshot reference. A persisted snapshot failure permanently denies eligibility, including when the report is regenerated from evidence.

The decision reasons name every blocking item. Promotion remains an explicit operator decision even when eligible.

## Rollback

If the new process fails before changing persistent data, switch back to the last known-good image.

If the upstream version changed or migrated persistent data, restore both:

1. the previous image tag;
2. the data snapshot taken immediately before promotion.

Do not assume a previous DSH binary can read data written by a newer release.

## Removing compatibility patches

When upstream DSH introduces an authenticated remote-administration mechanism with equivalent security properties, prefer it and retire the corresponding DSH Orbit patch. The desired end state is less patching over time, not a growing permanent fork.
