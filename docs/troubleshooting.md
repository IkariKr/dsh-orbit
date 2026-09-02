# DSH Orbit troubleshooting

This guide is for the implemented v0.3 Registry MVP. It describes diagnosis and
safe recovery; it does not relax a fail-closed check or change an RFC contract.

## Hub will not start

Read the classified `database startup failed (...)` message. Common causes:

- `unsupported-schema`: the database was created by a newer compatible binary;
  do not open it with an older Hub.
- `malformed-schema`: tables, columns, indexes, or constraints do not match the
  supported schema; preserve the original file and investigate from a copy.
- `integrity-failed`: SQLite page/B-tree integrity or foreign-key checks failed.
  Do not rebuild or overwrite the source database.
- `corrupt-database`: the file is not a readable SQLite database.
- `database-io`: permissions, read-only storage, or path problems.

Hub performs integrity and FK checks before migration/WAL mutation and after
migration. A failed check must occur before the `registry listening` message.
Keep any existing `-wal` and `-shm` sidecars with the original database while
collecting evidence.

## Migration problem

Stop the Hub and preserve a byte-for-byte copy of the input. Confirm the source
schema version and use a reviewed v1/v2/v3 migration path. A legacy schema-shape
or integrity failure must not be retried against the only copy. The supported
migration and health semantics are documented in [`registry-mvp.md`](registry-mvp.md).

## Backup or restore problem

- `destination-exists`: choose a new backup destination; backup never overwrites.
- `writers-active`: stop Hub and every Registry writer before restore.
- `integrity-failed` or `invalid-backup`: do not publish the image.
- `restore-mismatch`: retain the staging/quarantine artifacts and compare the
  non-secret state digest.
- A standalone backup has no copied WAL/SHM; never add old sidecars manually.

Use [`sop/v0.3-registry-backup-restore-sop.md`](sop/v0.3-registry-backup-restore-sop.md)
for the complete procedure.

## Browser gateway errors

A 401/403 can be expected when the gateway assertion, operator principal,
Origin, `Sec-Fetch-Site`, session, or CSRF token is absent or mismatched. Keep
TLS certificate validation enabled. Do not send `/api/v1/*` through the browser
gateway, and do not trust client-supplied assertion or principal headers.

## Node binding, retry, or revocation

- A persisted Hub URL mismatch fails closed; use the original binding.
- Network, timestamp, replay, rate-limit, unknown-key, and 5xx errors do not
  automatically mean revocation.
- `retrying` is runtime state; inspect the local state file and Hub health.
- A revoked Node does not automatically reenroll. Keep its state file and use
  the same operator token for explicit reenrollment.

## Rotation and reenrollment uncertainty

Never delete the state file after an uncertain identity-changing request.
Rotation recovery probes the persisted pending key and never generates a third
key. Reenrollment recovery replays the persisted request with the same
operator token and preserves the original node ID. If the process was killed,
restart the exact command with the same state path and token.

## Health and downtime

`registryContact` is heartbeat-only. Reports do not heal stale/lost contact.
After a long outage, expect `lost` plus `contact-lost` until an authenticated
heartbeat succeeds. Capabilities may be withheld while report evidence is
stale. Do not edit SQLite timestamps or shorten production thresholds to make a
real deployment appear healthy.

## Permissions and platform notes

On POSIX, Registry DB, backup, restore images, and Node state are explicitly
private (`0600`). On Windows, POSIX permission-bit tests are skipped; use the
platform's ACL controls. The Windows environment also skips GNU-tar behavior
that cannot interpret Windows drive paths.

## Evidence and cleanup

Capture the exact commit, command, exit code, classified error, and sanitized
state summary. Never include private keys, plaintext tokens, credentials, CSRF
values, or storage secrets. Before removing a temporary root, stop only the
owned Hub/Node processes and await their `close` events. Do not use pattern
termination such as `pkill -f`.
