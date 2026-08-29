# Snapshot and rollback contract

Persistent-data protection is a required, machine-checkable step of every production upgrade. DSH Orbit defines the contract and the orchestration boundary; the downstream deployment implements the snapshot itself with whatever reviewed technology it runs — ZFS, Btrfs, NAS snapshots, reflinks, `rsync`, VM snapshots, or any other method.

A snapshot failure is a hard failure. It is never downgraded to a warning, and a failed or incomplete snapshot denies promotion readiness.

## Snapshot hook contract

The upgrade runner invokes one downstream snapshot hook before production promotion. The hook is a single executable file configured with `DSH_SNAPSHOT_HOOK`. Supported interpreters mirror the runtime hooks: `*.mjs` and `*.js` run with Node.js, `*.sh` runs with `/bin/sh`.

### Required inputs (environment)

| Variable | Meaning |
| --- | --- |
| `DSH_SNAPSHOT_ID` | requested snapshot identifier |
| `DSH_DATA_ROOT` | persistent data root directory, or the downstream logical name for it |
| `DSH_ORBIT_REVISION` | exact DSH Orbit revision to record in the manifest |
| `DSH_VERSION` | candidate DSH version to record in the manifest |
| `DSH_SNAPSHOT_MANIFEST` | output path the hook must write its manifest to |
| `DSH_SNAPSHOT_TIMEOUT_SECONDS` | runner-side timeout in seconds (default `900`) |

### Exit behavior and completion

- exit `0` plus a completed manifest at `DSH_SNAPSHOT_MANIFEST` — the snapshot is complete;
- any non-zero exit, a timeout, or a missing/invalid manifest — the snapshot failed and promotion readiness is denied.

A completed manifest is a JSON object with exactly these fields, all non-empty strings:

```text
snapshotId, createdAt, orbitRevision, dshVersion, dataRoot, method, restoreReference, status
```

`status` must be `complete`. Unknown fields are rejected fail-closed so storage credentials cannot ride along in the manifest. The manifest identifies the recovery point and must never embed storage credentials; validation errors report field names, never values.

The runner enforces `DSH_SNAPSHOT_TIMEOUT_SECONDS`, kills the hook on timeout, and treats the timeout as a failed snapshot. Secrets may be passed to the hook through the environment; they must not be printed, logged, or written into the manifest.

### Reference implementation

`examples/snapshot-hook-reference.sh` is a portable `tar.gz` reference that satisfies the contract on any POSIX host. Production sites replace it with their own reviewed snapshot logic.

Invoke the contract from the command line:

```sh
DSH_SNAPSHOT_HOOK=examples/snapshot-hook-reference.sh \
DSH_SNAPSHOT_MANIFEST=backups/manifest.json \
DSH_SNAPSHOT_ID=pre-upgrade-20260829 \
DSH_DATA_ROOT=/srv/dsh-production/data \
DSH_ORBIT_REVISION=$(git rev-parse HEAD) \
DSH_VERSION=0.1.1-rc.2 \
node scripts/run-snapshot.mjs
```

The command prints the promotion-readiness verdict and exits non-zero when the snapshot failed. `promotionReadiness()` in `src/snapshot-contract.mjs` exposes the same gate programmatically for the candidate upgrade runner.

## Copied-data candidate testing

Candidate validation must never run against the only known-good production copy. Downstream operators create an isolated copy before a candidate start:

1. complete a production snapshot per the contract above and record the manifest;
2. restore or copy the data into a separate candidate directory (for the reference method: extract the archive, for filesystem snapshots: clone it);
3. point the candidate container's data volume at the copy and start it on an isolated endpoint or port;
4. record which copy the candidate used; discard or refresh the copy between candidate runs.

A candidate run that mutated the copy leaves the production snapshot and the production data untouched. If the copy is lost, recreate it from the snapshot manifest's `restoreReference`.

## Rollback contract

Rollback tracks two independent operations. Image rollback alone is not a recovery plan when a candidate may have changed persistent data:

1. **Source/image rollback** — return to the last known-good image tag or Orbit revision. Required whenever the candidate is rejected.
2. **Persistent-data rollback** — restore the corresponding data snapshot (identified by the pre-promotion manifest's `restoreReference`) whenever the candidate ran against production data, because a newer DSH release may migrate or rewrite state that an older release cannot read.

Before an upgrade, the operator must be able to name both targets: the exact image/revision to roll back to, and the exact snapshot to restore. A rollback rehearsal or an explicitly reviewed restore procedure is part of production readiness.
