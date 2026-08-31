# Node Registry Client — state file schema and operational semantics

SOP Stage 2 Required Output: the Node local state file format is documented
here so future schema changes (and migrations) never become archaeology.

## Location and permissions

- Default path: `./node-state.json`; override with `DSH_ORBIT_NODE_STATE`.
- POSIX: the file is created and kept at **0600** (temp file written with
  mode 0600, then atomically renamed, then chmod 0600). This applies to
  **every** store that exists, including unenrolled stores that carry a
  `pendingEnrollment` with key material.
- A state file readable by group/other fails closed at CLI startup and is
  reported by `doctor` (`state-file-permissions`).
- Writes are atomic: temp file + `rename`. A crash at any point leaves the
  previous store intact; a half-written store is impossible.
- Loading validates the store immediately (semantics, not just JSON); a
  corrupt or invalid file refuses to load — it is never guessed at.

## Schema (version 1)

| Field | Type | Secret | Meaning |
| --- | --- | --- | --- |
| `schema` | integer | no | store schema version (1) |
| `nodeId` | `node_` + 32 hex \| null | no | Hub-issued identity; null until enrolled |
| `publicKeyHex` | 64 hex \| null | no | current main Ed25519 public key (wire form) |
| `privateKeyHex` | 96 hex (PKCS8 DER) \| null | **YES** | current main private key — never leaves the node |
| `hubBaseUrl` | canonical URL \| null | no | persisted Hub binding (scheme/host/port, no path/query/fragment) |
| `state` | `unenrolled` \| `active` \| `revoked` | no | persisted lifecycle state |
| `rotation` | object \| null | mixed | credential rotation marker; pending markers carry a **secret** new private key |
| `pendingEnrollment` | object \| null | mixed | enrollment intent; carries a **secret** keypair |
| `pendingReenrollment` | object \| null | mixed | re-enrollment intent; carries a **secret** new keypair |
| `updatedAt` | ISO string | no | last successful write |

### Identity invariants (validation on every load and write)

- `unenrolled`: `nodeId`/`hubBaseUrl`/main keys must be null. May carry a
  `pendingEnrollment` (with its own keypair + canonical Hub binding).
  Must NOT carry `rotation` or `pendingReenrollment`.
- `active` / `revoked`: `nodeId` + `hubBaseUrl` + main keypair must all be
  present, and the keypair must self-verify (private key signs a fixed
  probe verifiable with the public key). `pendingEnrollment` is forbidden.
  `pendingReenrollment` is allowed only in `revoked` and its `nodeId` must
  equal the store's `nodeId`.
- Rotation relations: a **pending** rotation (`overlapUntil: null`) must have
  `oldKeyId` equal to the current main keyId and the retained old private
  key must sign for the current main public key, plus a full consistent new
  keypair whose keyId matches `newKeyId`. A **completed** rotation must have
  `newKeyId` equal to the current main keyId (the main identity moved).
- `pendingEnrollment.hubBaseUrl` must be canonical and is part of the
  intent: the intent can never be replayed against another Hub.

## Persisted states

- `unenrolled` — no identity. Transition: `enroll(token)` → `active`.
- `active` — enrolled, authenticated, heartbeating (runtime may be
  `retrying` while the Hub is unavailable; that is not persisted).
- `revoked` — the Hub revoked/tombstoned this identity. Frozen rule: the
  Node never auto-re-enrolls and never mints a new nodeId; recovery is an
  explicit operator re-enrollment. `active` → `revoked` persists only on
  Hub codes `revoked` / `key-revoked` (never on timestamp/signature/replay/
  rate-limit/unknown-key errors, 429, or 5xx).
- Runtime-only: `retrying` (backoff active) and `idle`.

## Pending intents (uncertain-output principle)

Every identity-changing operation persists its intent BEFORE the request;
Hub commit + lost response + restart is always reconcilable.

### pendingEnrollment

```json
{
  "enrollmentRequestId": "32 lowercase hex",
  "publicKeyHex": "64 hex",
  "privateKeyHex": "96 hex",
  "hubBaseUrl": "canonical",
  "generatedAt": "ISO"
}
```

Persisted before `POST /api/v1/enroll`. A retry with the same operator token
replays the identical `enrollmentRequestId` + `publicKeyHex` (exact replay;
the Hub returns its recorded result). The enrollment token itself is never
stored. A runtime Hub that differs from `pendingEnrollment.hubBaseUrl` fails
closed.

### pendingReenrollment

```json
{
  "reenrollmentRequestId": "32 lowercase hex",
  "publicKeyHex": "64 hex",
  "privateKeyHex": "96 hex",
  "nodeId": "node_ ...",
  "generatedAt": "ISO"
}
```

Persisted before `POST /api/v1/reenroll` on a `revoked` node. Retries with
the same re-enrollment token replay exactly. The ORBIT-REENROLL-V1
possession proof signer is chosen from the local key material: when a
rotation was in flight at deletion time the proof first tries the pending
new key (the tombstone may have retained it) and falls back to the current
main key only on `possession-proof-failed` (which consumes nothing).

### rotation

```json
{
  "oldKeyId": "32 hex",
  "oldPrivateKeyHex": "96 hex (secret)",
  "newKeyId": "32 hex",
  "newPublicKeyHex": "64 hex (pending only)",
  "newPrivateKeyHex": "96 hex (pending only, secret)",
  "generatedAt": "ISO (pending only)",
  "overlapUntil": "ISO | null"
}
```

`overlapUntil: null` = pending (persisted before `POST /api/v1/
credential-rotate`). After an uncertain outcome the Node probes with the
pending new key: accepted → promote locally; `unknown-key` on the pending
key means NOT committed (never revokes the node) and the SAME pending
public key is re-submitted under the old key when it still works. Never a
third generated key. `overlapUntil` set = committed; the new key is the
main identity; the marker keeps the old key for diagnostics until the
overlap ends. A completed marker is pruned once past its overlapUntil.

## Crash-recovery semantics

- Restart = load the store (validated) + `recoverAfterRestart()`; identity
  is preserved; nothing re-enrolls.
- Pending rotation resolves by commit detection on the next tick.
- Pending enrollment/reenrollment await the same operator token and replay
  exactly.
- The Hub binding is enforced at construction: an enrolled store (or a
  pending enrollment) whose persisted binding differs from the runtime
  configuration refuses to start or talk to another Hub.

## Doctor

`doctor` runs integrity checks (schema/identity/keypair/rotation/permissions)
plus a **non-mutating** HTTP reachability probe (any response proves the
listener is up). It never calls heartbeat and never changes Hub or local
state.

## Which fields are secrets

`privateKeyHex`, `rotation.oldPrivateKeyHex` (pending), `rotation.newPrivateKeyHex`,
`pendingEnrollment.privateKeyHex`, `pendingReenrollment.privateKeyHex`.
Everything else is metadata. The file as a whole must be 0600.