# RFC 0012: Reverse-connected nodes for v0.5

Status: **Proposed for v0.5 architecture review; remediated per Gate A review round 1 (2026-09-20, `docs/review/review-v0.5-stage0-rfc-sop-2026-09-20.md`). Product construction is blocked until the Stage 0 / Gate A review records GO.**

Depends on: RFC-0001 node identity, RFC-0003 node authentication, RFC-0005 enrollment and registry persistence, RFC-0006 machine API, RFC-0007 browser management API, RFC-0008 per-node Hub service identity, RFC-0009 capability/health semantics, RFC-0010 node endpoint/routing, RFC-0011 browser node selection, and authorization `V05-CONSTRUCTION-20260919-A1`.

## Goal

v0.5 adds one narrowly scoped capability: a registered DSH node that cannot accept inbound Hub connections may establish an authenticated outbound connection to Orbit and carry the **same RFC-0010 browser route** through that connection.

The public browser model does not change:

```text
Browser
   |
   | HTTPS / WSS
   v
selector + deterministic node authority
   |
   | RFC-0010 eligibility + ORBIT-ROUTE-V1
   v
Hub route proxy
   |
   +---- direct mode ----> server-reachable Node route ingress
   |
   +---- reverse mode ---> authenticated outbound reverse channel ---> Node
                                                             |
                                                             v
                                                       local DSH runtime
```

v0.5 also defines a separate **pairing** bootstrap for a new NAT-restricted installation. Pairing creates the same long-lived Orbit node identity and Ed25519 machine identity used elsewhere; it does **not** create a second class of node identity.

The design deliberately does not build a generic tunnel, VPN, service mesh, remote shell, fleet RPC bus, or automatic failover system.

## Decision summary

The following decisions are fixed for v0.5 construction:

1. A node has one explicit operator-controlled `routeMode`: `direct` or `reverse`. There is no `auto` mode.
2. Existing v0.4 nodes migrate to `direct`. A newly paired reverse node starts as `reverse`.
3. Public node authorities and selector semantics remain RFC-0010 / RFC-0011. Reverse mode changes only the Hub-to-node transport.
4. New NAT-restricted installations use a separate one-time **pair** bootstrap. Existing registered nodes do not pair again merely to open a reverse connection.
5. Pairing and normal machine traffic use the existing node Ed25519 identity model. No second permanent device credential is introduced.
6. A reverse node reaches the same Hub over HTTPS/WSS. Exact public machine/reverse paths are admitted by the gateway; arbitrary machine paths are not.
7. One authenticated reverse **control connection** exists per node. Browser payload does not travel on it.
8. Browser payload uses a bounded pool of authenticated reverse **data channels**. Each data channel carries at most one browser flow at a time. v0.5 intentionally does not implement a multiplexed custom stream protocol.
9. Every routed flow still carries the existing per-node `ORBIT-ROUTE-V1` proof. The reverse connection itself is not sufficient authority to route browser traffic.
10. Direct and reverse transports never silently fail over to each other.
11. `registryContact`, compatibility, DSH semantic health, reverse presence, and route reachability stay distinct facts.
12. Live reverse sessions are process memory, never restored from backup. After a Hub restart all reverse nodes reconnect.
13. The exact reverse-connection acceptance matrix in this RFC is mechanically enforced before v0.5 mounted evidence may pass.

---

## D1: Identity, route authority, and route mode

The stable identity remains the RFC-0001 `nodeId`.

The following are **not** identity:

- route target;
- reverse endpoint;
- reverse session ID;
- data-channel ID;
- public node route authority;
- display name;
- IP address or NAT mapping.

RFC-0010 still derives the browser authority from the node ID:

```text
https://n-<node-id-hex>.<route-domain>/
```

v0.5 adds one operator-owned routing field:

```text
routeMode = direct | reverse
```

Rules:

- schema migration defaults all existing v0.4 nodes to `direct`;
- a fresh pairing creates the new node with `routeMode = reverse`;
- changing `routeMode` is an authenticated operator action and is audited;
- a stored direct `routeTarget` may remain present while `routeMode = reverse`, but it is inactive;
- an online reverse session may remain present while `routeMode = direct`, but it is not used for browser routing;
- there is no automatic or priority-based selection between transports;
- changing mode affects **new** browser flows only. Existing flows retain their immutable transport snapshot until normal close; delete/revocation still terminates them immediately.

A node may therefore possess both direct metadata and a reverse session without creating an ambiguous routing decision.

---

## D2: Public reverse machine ingress

A NAT-restricted node needs a public outbound-reachable Orbit endpoint. v0.5 reuses the existing selector deployment authority rather than inventing a second node-route namespace.

For a reverse-connected node, this public authority is persisted as its canonical RFC-0005/RFC-0008 `hubBaseUrl`. The reverse control/data connection and the ordinary heartbeat/report/rotation requests all use that same canonical Hub binding. v0.5 does **not** add a second independently trusted `reverseBaseUrl` and does not silently rebind an existing node from one Hub authority to another.

A previously enrolled node may enable reverse mode without pairing only when its already-persisted canonical `hubBaseUrl` is reachable from its current network and exposes the v0.5 reverse machine surfaces defined below. Migrating an existing node to a different Hub authority is a separate explicit trust/binding migration and is not smuggled into reverse reconnect logic. A fresh NAT-restricted installation should use pairing so the correct public `hubBaseUrl` is established at bootstrap.

The outer gateway may publicly admit only the following exact Orbit-owned machine surfaces:

```text
POST /api/v1/pair
POST /api/v1/heartbeat
POST /api/v1/report-upload
POST /api/v1/credential-rotate
POST /api/v1/reenroll
GET  /api/v1/reverse/control      (WebSocket upgrade only)
GET  /api/v1/reverse/channel      (WebSocket upgrade only)
```

`/api/v1/enroll` remains outside the public reverse ingress. Server-reachable enrollment keeps its existing boundary.

The seven surfaces above are served by one Hub machine handler set on every machine ingress that a node's persisted canonical `hubBaseUrl` can reference:

- the pre-existing server-reachable machine listener keeps its RFC-0006 paths and additionally admits `POST /api/v1/pair`, `GET /api/v1/reverse/control`, and `GET /api/v1/reverse/channel` with identical semantics, so an already-registered node enables reverse mode through its existing binding without repair or rebinding;
- `/api/v1/enroll` remains server-reachability-only and is never added to the public projection;
- the public gateway is the outward projection of that same handler set behind mandatory verified TLS/WSS, gateway rate limits, header stripping, and the exact method/path allowlist above;
- machine paths are admitted only on the deployment-designated Hub authority referenced by `hubBaseUrl`; per-node route authorities (`n-<node-id-hex>.<route-domain>`) deny machine paths;
- v0.5 adds no rebinding, no second binding, and no `reverseBaseUrl` for reverse enablement.

Gateway rules are fixed:

- HTTPS/WSS is mandatory; no non-loopback plaintext exception exists for the public reverse ingress;
- normal certificate and hostname/SAN verification applies on the node;
- the gateway forwards only the exact method/path pairs above;
- unknown path is 404 and wrong method is 405 before Hub business logic;
- the gateway consumes/strips its own authentication metadata and never injects an operator principal into these machine requests;
- browser/operator cookies and gateway assertion headers are stripped before the Hub machine handler;
- reverse machine traffic never inherits a browser session;
- WebSocket control/channel upgrades are native machine traffic and MUST omit `Origin`; any request carrying `Origin` is rejected with 403 before upgrade;
- client-supplied forwarded/proxy identity headers remain untrusted;
- public machine requests retain the existing per-IP and protocol-level rate limits;
- pairing token plaintext, machine signatures, reverse session IDs, and route proofs are credential-sensitive for logging/redaction.

The existing RFC-0006 machine routes keep their protocol semantics. The only boundary change is that the exact allowlisted routes above become reachable through the authenticated public gateway path.

---

## D3: Pairing a new reverse installation

Pairing is a v0.5 bootstrap and is distinct from RFC-0005 server-reachable enrollment.

### D3.1 Operator token

The existing RFC-0007 token-management surface is extended rather than duplicated:

```text
POST /hub/tokens   { "purpose": "pair", "ttlSeconds": ... }
GET  /hub/tokens
```

The semantics are fixed:

- purpose is exactly `pair`;
- token is 128 random bits;
- TTL default 10 minutes, configurable 1–60 minutes;
- `boundNodeId` is forbidden/non-null rejected for `pair`;
- Hub stores only SHA-256(token), never plaintext;
- plaintext is returned exactly once by the mint response;
- later token listing exposes metadata only, never plaintext or digest;
- token mint/use is audited;
- per-token and per-IP attempt limits apply;
- v0.5 adds no separate pairing-token management subsystem and no new token-revocation API; the short TTL + one-time consumption model remains the lifecycle boundary.

v0.5 deliberately reuses the proven RFC-0005 token/idempotency persistence rather than creating parallel token tables. The v5→v6 Registry migration extends `enrollment_tokens.purpose` with exactly one new value, `pair`, and extends `enrollment_results.kind` with exactly one new value, `pair`. A pair token has `bound_node_id = NULL`; `/api/v1/enroll` and `/api/v1/reenroll` continue to reject it. External pairing semantics remain a separate API even though the storage primitives are shared.

### D3.2 Node request

Before pairing, the node:

1. generates an Ed25519 keypair locally;
2. persists the private key before network submission;
3. generates `pairingRequestId` = 128 random bits encoded as 32 lowercase hex;
4. sends:

```http
POST /api/v1/pair
Content-Type: application/json
```

with:

```json
{
  "token": "<pair token>",
  "pairingRequestId": "<32 lowercase hex>",
  "publicKey": "<RFC-0006 encoding>"
}
```

No node ID exists yet, so no machine signature is possible for this one request. TLS plus the single-use pairing token authenticate the bootstrap.

### D3.3 Atomic success and idempotency

On first success the Hub performs one transaction:

```text
validate unexpired unused pair token
→ consume token
→ record pairing result keyed by pairingRequestId
→ mint new RFC-0001 nodeId
→ create node + node key
→ set routeMode = reverse
→ provision normal per-node RFC-0008 Hub route identity
→ audit
```

The result returns at minimum:

- `nodeId`;
- canonical public Hub base URL for the v0.5 machine ingress;
- heartbeat cadence;
- reverse protocol version `orbit-reverse-v1`.

An exact replay of `token + pairingRequestId + publicKey` returns the exact recorded result within the normal 90-day replay retention. Reusing the token/request ID with different content is denied.

A failed pre-validation or failed transaction consumes nothing.

### D3.4 Recovery boundaries

Pairing never becomes an attestation or force-rebind mechanism.

- A currently registered node opens reverse connections with its existing node credential. It does not pair again.
- A tombstoned node may recover the same node ID only through the existing RFC-0005/RFC-0006 reenrollment path with original-private-key possession.
- A pair token can never restore a tombstoned node ID.
- Loss of the node store/private key means a new pairing and a **new nodeId**.
- Pairing an installation that already has a durable active node ID is rejected with an explicit reconcile error.

---

## D4: Reverse control connection

After the node has a normal machine identity, it opens:

```http
GET /api/v1/reverse/control
Upgrade: websocket
```

over verified WSS.

The HTTP upgrade is authenticated with the existing RFC-0006 machine headers and `ORBIT-MACHINE-V1` signing rules:

- method = `GET`;
- path = exact `/api/v1/reverse/control`;
- body hash = SHA-256(empty body);
- timestamp and nonce rules are unchanged;
- nonce reservation remains persistent/transactional;
- a signature for any other method/path cannot authenticate this upgrade.

The Hub accepts the upgrade only for an active node/key.

### D4.1 Session establishment

The Hub generates a random 128-bit `reverseSessionId` for each accepted control connection. It is an ephemeral binding value, not a replacement credential.

The Hub sends a small control message:

```json
{
  "type": "session",
  "protocol": "orbit-reverse-v1",
  "reverseSessionId": "<opaque 32 hex>",
  "idleTarget": 8,
  "maxChannels": 32
}
```

The node responds:

```json
{
  "type": "ready",
  "protocol": "orbit-reverse-v1",
  "routeReady": true|false
}
```

Only then is the session `online`.

Allowed control traffic is deliberately small:

Hub → Node:
- `session`;
- WebSocket ping;
- `close` with an Orbit reason code.

Node → Hub:
- `ready`;
- `status` when local route readiness changes;
- WebSocket pong.

Arbitrary commands, DSH RPCs, shell requests, task execution, browser payload, and fleet messages are forbidden on the control channel.

### D4.2 Duplicate control connections

A new authenticated control connection does **not** displace the current session until it reaches valid `ready`.

After the new session becomes ready, the Hub atomically:

1. marks the new `reverseSessionId` current;
2. closes the old control session;
3. closes every old-session data channel;
4. ignores all late events from the old generation.

This prevents a half-open reconnect from destroying a healthy session and prevents an old disconnect callback from clearing a new session.

Pending (authenticated, not yet `ready`) control connections are bounded per node:

- a new authenticated control connection for a node closes that node's prior pending connections;
- a pending connection that has not reached `ready` within 30 seconds is closed;
- neither rule can evict the current ready session.

### D4.3 Liveness

- Hub sends WebSocket ping every 20 seconds.
- Missing pong for 10 seconds closes the control session.
- Control close changes reverse presence to offline immediately for a `routeMode = reverse` node; on a `direct` node the dead non-routing session falls back to `unknown`.
- The node reconnects with exponential backoff 1s, 2s, 4s … capped at 30s with ±20% jitter.
- A successful ready session resets the backoff.
- Live session state is never persisted.

---

## D5: Reverse data-channel pool

v0.5 intentionally avoids a multiplexed general tunnel.

A reverse node maintains a pool of outbound authenticated WebSocket data channels:

```http
GET /api/v1/reverse/channel
Upgrade: websocket
X-Orbit-Reverse-Session: <current reverseSessionId>
```

Each channel independently carries a valid RFC-0006 machine-authenticated upgrade. The Hub additionally requires:

- channel node ID equals the current control-session node ID;
- `X-Orbit-Reverse-Session` equals the current ready session;
- the node credential used by the channel is currently accepted.

The session header is a binding value, not sufficient authentication by itself.

Defaults and bounds:

- idle target: 8 channels;
- max channels: 32;
- operator/configurable idle target: 1–16;
- configurable max: 4–64;
- idle target must be ≤ max;
- the node replenishes the pool asynchronously;
- the Hub never asks another node for spare capacity.

A data channel has this lifecycle:

```text
connecting → idle → busy(flow) → idle
                    |
                    +→ closed/error
```

One data channel carries **one browser flow at a time**. No stream IDs and no cross-flow multiplexing exist in v0.5.

If no idle channel exists, the Hub may wait up to 2 seconds for the same node to replenish its pool. After that the request fails 503 `reverse-capacity`. It never falls back to a direct target or another node.

---

## D6: Per-flow wire contract

The Hub may assign a data channel only after normal RFC-0010 selector/route eligibility succeeds for that exact node.

### D6.1 OPEN

The first Hub message for a flow is UTF-8 JSON:

```json
{
  "type": "open",
  "requestId": "<128-bit random hex>",
  "mode": "http|websocket",
  "method": "GET",
  "rawTarget": "/exact/path?query",
  "routeAuthority": "n-<node>.example",
  "headers": [["name", "value"]],
  "routeProof": {
    "keyId": "...",
    "timestamp": 0,
    "nonce": "...",
    "signature": "..."
  }
}
```

Rules:

- OPEN JSON is at most 64 KiB;
- header representation is an ordered array so duplicate fields are not silently collapsed;
- the Hub applies the same RFC-0010 header sanitation before OPEN;
- browser/client `X-Orbit-*`, gateway assertion, and management credentials are removed;
- the public `Host` / authority is represented by `routeAuthority`, not accepted from an untrusted node value;
- `routeProof` is the **existing ORBIT-ROUTE-V1** proof for this node/authority/method/raw target;
- the node verifies that proof with its RFC-0008 public-key set before touching DSH;
- an invalid/stale/replayed/wrong-node proof aborts the flow before downstream connection;
- direct route ingress and reverse flow admission for the same node use one shared process-level `ORBIT-ROUTE-V1` nonce/replay cache, so a still-fresh proof accepted on one transport cannot be accepted again on the other transport. The existing RFC-0010 bounded restart residual risk remains unchanged.

Reverse mode therefore does not weaken or replace RFC-0010 Hub→Node authorization.

### D6.2 HTTP body and response

After OPEN:

Hub → Node text messages:
- `{"type":"request-end","requestId":"..."}`;
- `{"type":"abort","requestId":"...","code":"..."}`.

Hub → Node binary messages:
- opaque request-body bytes.

Node → Hub text messages:
- `{"type":"response","requestId":"...","status":200,"headers":[...]}`;
- `{"type":"response-end","requestId":"..."}`;
- `{"type":"abort","requestId":"...","code":"..."}`;
- `{"type":"idle"}` only after the flow is fully torn down.

Node → Hub binary messages:
- opaque response-body bytes.

The node-local adapter preserves the same DSH-facing semantics as RFC-0010. Orbit does not parse DSH application payloads.

### D6.3 WebSocket flows

For `mode = websocket`, OPEN carries the ordinary browser upgrade metadata after RFC-0010 sanitation.

The node attempts the local DSH WebSocket upgrade and sends a `response` message with the actual status/headers.

If status is 101, the data channel enters opaque upgraded mode:

- Hub → Node binary messages are exact bytes from the browser-side upgraded socket;
- Node → Hub binary messages are exact bytes from the DSH-side upgraded socket;
- Orbit does not parse WebSocket application frames;
- when either side closes, the opposite side is closed and the channel returns to idle only after complete teardown.

Non-101 responses remain ordinary HTTP responses and preserve downstream status/body without failover.

This is still not a general TCP tunnel: an upgraded data channel exists only for one already-authorized RFC-0010 browser route to the node's configured local DSH runtime.

---

## D7: Bounded streaming and backpressure

Every data channel must be bounded.

Fixed v0.5 transport limits:

- maximum binary message payload: 64 KiB; larger source chunks are split;
- soft queued-byte high-water mark per direction/channel: 512 KiB;
- producer resumes below 256 KiB;
- hard queued-byte cap per direction/channel: 2 MiB;
- no-progress stall timeout while above the soft mark: 30 seconds;
- exceeding the hard cap or stall timeout aborts only that flow and closes the affected data channel;
- source streams are paused while the transport is above its soft mark;
- an aborted flow is never transparently retried.

The implementation may use Node stream/socket primitives of its choice, but tests must prove bounded buffering and cleanup. Increasing these limits is a protocol/configuration change requiring explicit review, not an incidental tuning patch.

---

## D8: Presence, reachability, heartbeat, and compatibility

v0.5 adds one read-model dimension:

```text
reversePresence = unknown | online | offline
```

It does not replace existing dimensions.

- `registryContact` remains driven only by RFC-0009 heartbeat.
- `orbitCompatible`, `dshHealthy`, and `web.routes` remain report-derived.
- `reversePresence` is current authenticated reverse control-session state. It is `online` when a current ready session exists; it is `offline` when `routeMode = reverse` and no ready session exists; it is `unknown` only for a `direct` node with no reverse session, where reverse presence is not an active routing fact. A ready reverse session on a direct-mode node may still be displayed as `online`, but it remains ineligible for routing while mode is direct. When that session dies, presence falls back to `unknown`.
- `reachable` remains the Hub's route-transport readiness result, but its source now depends on explicit `routeMode`.

For `routeMode = direct`:
- RFC-0010 probe behavior is unchanged.

For `routeMode = reverse`:
- `reversePresence = online` requires a current ready control session;
- node control `ready/status` includes only generic local DSH transport readiness;
- `reachable = ok` iff the current reverse session is online **and** current local route readiness is true;
- control loss immediately makes `reversePresence = offline` and `reachable = unreachable`;
- local DSH transport loss makes `reachable = unreachable` without changing `registryContact`;
- recovery to a current authenticated ready session with local route readiness restores `ok`.

A connected reverse socket alone therefore does not imply DSH health or compatibility.

The node continues using the ordinary RFC-0006 heartbeat/report/credential-rotation routes through the public allowlisted machine ingress. This deliberately avoids smuggling heartbeat/report semantics into the reverse control channel.

RFC-0008 Hub route public-key synchronization also remains on the authenticated heartbeat response. Reverse transport does not create a second Hub identity lifecycle.

---

## D9: Route eligibility and no implicit failover

RFC-0010 eligibility is extended by explicit route mode.

### Direct mode

Unchanged v0.4 conditions:

- node active;
- `routeMode = direct`;
- operator-approved route target;
- `reachable = ok`;
- active per-node Hub route identity;
- fresh `web.routes`.

### Reverse mode

Required:

- node active;
- `routeMode = reverse`;
- current `reversePresence = online`;
- `reachable = ok`;
- active per-node Hub route identity;
- fresh `web.routes`;
- at least one data channel is available: eligibility uses a non-destructive pool-availability predicate, and the 2-second capacity wait with its 503 `reverse-capacity` failure happens only when a flow is actually assigned.

The selector keeps the same deterministic Open target. It may display `routeMode` and reverse presence, but it does not invent another selection system.

Failure is always same-node fail-closed:

```text
direct selected + direct unavailable
    -> fail selected node
    -> NEVER use reverse automatically

reverse selected + reverse unavailable
    -> fail selected node
    -> NEVER use stored direct routeTarget automatically
```

An operator may explicitly change `routeMode`; that action is audited.

---

## D10: Credential rotation, deletion, and reenrollment

### Node credential rotation

Each control/data connection records the node key ID that authenticated its upgrade.

- during the normal RFC-0006 overlap, either accepted node key may establish a new reverse connection;
- when a node key becomes revoked, any reverse control session authenticated with that key is closed;
- all associated data channels are closed;
- the node reconnects using its current key.

### Hub route identity

Per-flow `ORBIT-ROUTE-V1` keeps using RFC-0008.

- active/rotating Hub route keys behave exactly as direct mode;
- a reverse session cannot route until the Hub route identity is active;
- stale/deleted-era Hub route keys never become valid merely because a reverse session exists.

### Deletion

Operator delete:

1. makes route eligibility false immediately;
2. revokes normal node keys;
3. revokes Hub route identity as already required;
4. closes current reverse control/data channels;
5. makes direct bookmarks fail closed.

A late frame from the deleted session is ignored.

### Reenrollment

RFC-0005 reenrollment remains the only same-node-ID recovery path.

Successful reenrollment:

- restores the same node ID;
- provisions a **fresh** Hub route identity;
- never reactivates deleted-era route keys;
- retains the operator route mode unless explicitly changed;
- requires a new reverse connection before reverse Open becomes eligible.

---

## D11: Persistence, migration, restart, and backup

v0.5 persistent additions are intentionally small.

The first v0.5 Registry schema is **v6**. Its persistence delta from accepted v0.4 schema v5 is fixed:

- `nodes.route_mode TEXT NOT NULL DEFAULT 'direct' CHECK(route_mode IN ('direct','reverse'))`;
- `enrollment_tokens.purpose` domain extends from `enroll | reenroll` to `enroll | reenroll | pair`; pair rows require `bound_node_id IS NULL`;
- `enrollment_results.kind` domain extends with `pair` so exact pairing replay uses the existing durable idempotency-result mechanism;
- no `reverse_sessions`, `reverse_channels`, or live-presence table is added;
- audit/events record pairing and route-mode changes through the existing tables.

The migration may rebuild SQLite tables as needed to change CHECK domains, but must preserve all accepted v0.4 rows byte/semantically equivalent for fields not being migrated.

Live reverse session IDs, control sockets, data channels, idle-pool state, and queued browser requests are **never** persistent state.

Migration rules:

- every accepted v0.4 node migrates to `nodes.route_mode = 'direct'`;
- existing route targets and Hub route identities are preserved exactly;
- pairing tables/state start empty;
- migration is idempotent;
- rollback/restore does not manufacture an `online` reverse presence.

Backup/restore:

- preserves node identity, route mode, pairing audit/result retention, keys, route targets, and Hub route identities;
- does not preserve live reverse sessions;
- after restore every reverse node starts `reversePresence = unknown/offline` until it authenticates a fresh control session.

Hub restart has the same rule: no phantom online session may survive process restart.

---

## D12: Operator and selector surfaces

Minimum operator capabilities:

- mint/list pair-purpose token metadata through the existing `/hub/tokens` surface without plaintext replay;
- see node `routeMode`;
- explicitly set `direct` / `reverse`;
- see `reversePresence`, `reachable`, existing compatibility/health, and last reverse transition;
- distinguish “reverse offline” from “DSH transport unavailable” and from “compatibility withheld”.

Minimum selector change:

- current RFC-0011 row remains authoritative;
- display transport mode/presence when useful;
- Open still navigates to the same deterministic node authority;
- Open eligibility is server-derived;
- no browser-side derivation of reverse eligibility;
- no hot swap and no hidden transport fallback.

No v0.5 UI is allowed to introduce multi-node execution or session aggregation.

---

## D13: Security invariants

The following are release-blocking invariants:

- no insecure TLS/hostname bypass;
- no system Root-store mutation in verification; `docs/sop/verification-tls-trust-policy.md` applies;
- reverse public gateway admits only the exact paths/methods in D2;
- `/api/v1/enroll` is not made public by v0.5;
- pair tokens are digest-only at rest and plaintext-once;
- pair tokens are not machine credentials after pairing;
- control/data upgrades require valid current node machine authentication;
- a reverse session ID alone authenticates nothing;
- a control session for node A cannot accept a channel authenticated as node B;
- every routed flow still requires valid `ORBIT-ROUTE-V1`;
- client-supplied Orbit route/machine/reverse headers are sanitized at their relevant boundary;
- no browser/operator/gateway credential reaches DSH;
- no node-local DSH secret reaches the Hub;
- no data channel may nominate another destination;
- no generic CONNECT/TCP forwarding exists;
- no reverse flow may target a sibling node;
- no automatic direct↔reverse failover exists;
- stale control generations cannot clear/override a newer ready generation;
- all queues/connections are bounded and cleaned on abort;
- logs/evidence never dump pair tokens, node private keys, Hub private keys, cookie values, route signatures, machine signatures, or reverse session IDs.

---

## D14: Canonical v0.5 acceptance matrix

The harness must expose these exact field names. A release candidate cannot enter mounted evidence until the matrix shape is mechanically frozen.

| # | Field | Minimum evidence |
| ---: | --- | --- |
| 1 | `pairTokenMinted` | automated + mounted |
| 2 | `pairTokenDigestOnly` | automated |
| 3 | `pairFreshNodeSuccess` | automated + mounted |
| 4 | `pairReplayIdempotent` | automated |
| 5 | `pairDifferentContentDenied` | automated |
| 6 | `pairWrongPurposeDenied` | automated |
| 7 | `pairExpiredDenied` | automated |
| 8 | `pairLostKeyCreatesNewNodeId` | automated |
| 9 | `existingNodeReverseConnectsWithoutRepair` | automated |
| 10 | `publicMachineIngressAuthenticated` | automated + mounted |
| 11 | `machineWrongSignatureDenied` | automated |
| 12 | `machineNonceReplayDenied` | automated |
| 13 | `machineStaleTimestampDenied` | automated |
| 14 | `reverseTlsUnknownCaDenied` | automated + mounted |
| 15 | `reverseTlsWrongSanDenied` | automated + mounted |
| 16 | `reverseControlOnline` | automated + mounted |
| 17 | `duplicateControlDeterministicTakeover` | automated + mounted |
| 18 | `controlReconnectAfterNetworkLoss` | automated + mounted |
| 19 | `hubRestartReconnect` | automated + mounted |
| 20 | `nodeRestartReconnect` | automated + mounted |
| 21 | `reversePresenceIndependentOfRegistryContact` | automated |
| 22 | `reverseDshLossUnreachable` | automated + mounted |
| 23 | `reverseDshRecoveryReachable` | automated + mounted |
| 24 | `dataChannelPoolBounded` | automated |
| 25 | `httpRootReverse` | automated + mounted |
| 26 | `staticAssetReverse` | automated + mounted |
| 27 | `streamingUploadReverse` | automated + mounted |
| 28 | `websocketUpgradeReverse` | automated + mounted |
| 29 | `websocketPingPongReverse` | automated + mounted |
| 30 | `websocketLargePayloadReverse` | automated + mounted |
| 31 | `cookieIsolationReverse` | automated + mounted |
| 32 | `routeProofWrongNodeDenied` | automated |
| 33 | `routeProofReplayDenied` | automated |
| 34 | `channelAbortCleanup` | automated + mounted |
| 35 | `noCredentialLeak` | automated + mounted |
| 36 | `nodeAOutageIsolation` | automated + mounted |
| 37 | `nodeBHealthyDuringAOutage` | automated + mounted |
| 38 | `noImplicitDirectFallback` | automated + mounted |
| 39 | `noImplicitReverseFallback` | automated + mounted |
| 40 | `explicitRouteModeSwitch` | automated + mounted |
| 41 | `directModeRegression` | automated + mounted |
| 42 | `credentialRotationReconnect` | automated + mounted |
| 43 | `deleteClosesReverseSession` | automated + mounted |
| 44 | `reenrollFreshHubRouteIdentity` | automated + mounted |
| 45 | `deletedBookmarkFailClosed` | automated + mounted |
| 46 | `hubRestartNoPhantomReverseSession` | automated + mounted |
| 47 | `backupRestoreNoLiveReverseSession` | automated |
| 48 | `selectorReverseEligibility` | automated + mounted |

All 48 fields are mandatory for final candidate qualification. A field that is not executed is `NOT_EXECUTED`, never prose-renamed into PASS.

The mounted run may consume pre-run automated qualification results only when they are freshly bound to the exact frozen candidate and included in the evidence manifest. Historical rebinding is forbidden.

---

## D15: Canonical mounted topology

The v0.5 final mounted run must contain at least:

```text
Gateway / Hub
   |
   +-- Node A: direct/server-reachable regression node
   |
   +-- Node B: reverse-only node
         - inbound Hub -> Node route connection is demonstrably denied/unavailable
         - outbound HTTPS/WSS Node -> Hub succeeds
         - routeMode = reverse
```

For Node B, evidence must prove that the Hub cannot reach a direct Node route-ingress target during the run. A reverse PASS is invalid if the same node is accidentally reachable through a hidden direct fallback.

Both node authorities must remain the normal RFC-0010 authorities under one selector route domain.

---

## Explicit non-goals

v0.5 does not implement:

- a general TCP/UDP tunnel;
- VPN semantics;
- arbitrary port forwarding;
- SOCKS/CONNECT proxying;
- service discovery;
- multiple simultaneous transport priorities;
- automatic direct/reverse failover;
- multi-Hub HA/shared reverse-session state;
- cross-node browser session migration;
- multi-node concurrent session control;
- fleet commands/tasks;
- remote shell/task execution over the control channel;
- DSH-private RPC or authentication logic in the Hub;
- a new node route authority or selector architecture;
- a new DSH compatibility profile merely to make reverse transport pass.

---

## Construction seams

These are recommended ownership boundaries, not public API promises:

- Registry/persistence: pairing state + route mode in `src/registry/**`;
- reverse Hub connection/session manager: a small `src/registry/reverse-*.mjs` seam;
- reverse Node client: a small `src/node/reverse-*.mjs` seam;
- existing `route-proxy.mjs`: select a direct or reverse **transport adapter** from the immutable route snapshot; do not duplicate selector/routing policy;
- gateway: exact public machine/reverse allowlist in `docker-registry/**`;
- UI: minimal extensions to current node detail/selector views;
- tests: protocol/state-machine tests first, mounted harness last.

If implementation requires changing any decision in D1–D15, STOP product construction and return to architecture review rather than silently evolving the protocol in code.
