# DSH Orbit troubleshooting

This guide covers the implemented v0.3 Registry MVP and the v0.4 Stage 7
failure, restart, and compatibility hardening. It describes diagnosis and safe
recovery; it does not relax a fail-closed check or change an RFC contract.

## v0.4 Stage 7 operational troubleshooting

The procedures in this section are operator guidance for the accepted v0.4
failure boundaries. Preserve the exact candidate commit, classified error, and
sanitized state summary when collecting evidence. Never include private keys,
plaintext tokens, credentials, cookies, CSRF values, gateway secrets, or raw
authenticated headers in a report.

### Route/Hub identity backup and restore

Before restoring Registry state, stop Hub and every Registry writer. Use the
standalone `VACUUM INTO` backup procedure; do not copy a live `.db` file and do
not attach the source database's `-wal` or `-shm` files to a restored image.
Quarantine restore staging and compare only the non-secret operational state:
node ID, route target, route-key ID/public key/state, overlap metadata,
capabilities, and reachability. A restore mismatch is a hard failure: preserve
the source and staging files and do not publish the image.

### Hub route-key rotation and restart

During rotation, expect one old key in `rotating` overlap and one new key in
`active` state. A Hub restart must preserve both key IDs and `revoke_after`; it
must not create a third key, reset overlap, or revoke the old key early. If the
same overlap is not present after restart, stop the rollout and retain the
pre-rotation backup. The scheduled revocation is the point at which the old key
must stop being accepted.

### Nonce replay and RouteIngress restart

RouteIngress replay protection is process-local. A repeated timestamp/nonce/proof
must fail within one process, but restarting RouteIngress resets the in-memory
nonce cache. This is the accepted bounded restart replay window under the
single-Hub and timestamp-skew assumptions; it is not durable replay prevention.
Expired or skewed timestamps, bad signatures, and wrong authorities must still
fail closed after a restart.

### TLS trust failures

An `unknown CA` or `wrong SAN` route-probe failure is expected to fail closed.
Verify the intended system or private CA and the certificate SAN before changing
routing state. Do not disable hostname validation, set
`NODE_TLS_REJECT_UNAUTHORIZED=0`, use `rejectUnauthorized: false`, or pass an
ignore-certificate-errors flag. Once the matching CA/SAN certificate is
restored, the route probe should recover normally.

### DSH loss behind a live RouteIngress

If RouteIngress remains alive while the downstream DSH process is stopped,
`route-ready` must fail and Hub probes must eventually set the node to
`reachable=unreachable`; the selector must disable Open for that node. A second
healthy node must remain `reachable=ok` and must not receive silent failover
traffic. After DSH and its reviewed internal gateway are restored, confirm a
signed route-ready success, then wait for the normal authenticated probe to
return the node to `reachable=ok` before reopening it.

### Compatibility withdrawal and Open availability

An unsupported DSH version, a missing compatibility profile, or a missing,
failed, or `not_run` `webSocketTransport` check must withhold `web.routes` and
leave Open unavailable. Do not infer compatibility from a similar version
string or manually add a profile entry in production. Re-run the reviewed
compatibility evidence against the exact approved DSH baseline.

### Delete, bookmark, and reenroll

After a node is deleted, its old route identity and direct bookmark must fail
closed and the node must remain unavailable until reenrollment completes. A
same-node-ID reenrollment still requires a fresh Hub route key, fresh route
target state, and fresh compatibility evidence; the old proof must not revive
the old route identity. Keep the tombstone and old state until the reviewed
reenrollment procedure has completed.

### HTTP/WS abort and capacity cleanup

For a client abort, downstream abort, upgrade failure, or WebSocket disconnect,
confirm that the socket is destroyed, listeners and timeouts are removed, and
the global/per-node counters return to their prior capacity. Repeat the
connect/abort cycle when diagnosing a suspected leak. A single abnormal
connection must not permanently consume a slot or leave a stale routing
snapshot. Stop the affected candidate if counters do not recover; do not
work around the limit by raising it.

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
