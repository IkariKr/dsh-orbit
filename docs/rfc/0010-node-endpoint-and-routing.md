# RFC 0010: Node endpoint and routing model for v0.4

Status: Proposed for v0.4 architecture review. This RFC freezes only Orbit-owned routing semantics. It deliberately does not freeze DSH-internal authentication, cookie, RPC, plugin, or frontend implementation details because DSH remains fast-moving.

Depends on: RFC-0001 node identity, RFC-0003 node authentication, RFC-0008 Hub service identity lifecycle, RFC-0009 capability and health semantics.

## Goal

v0.4 gives one Orbit entry point a safe way to open one of several registered, **server-reachable** DSH nodes. The Hub routes ordinary browser HTTP and WebSocket traffic to the selected node without making the node address its identity and without teaching the Hub DSH-private protocol details.

v0.4 does not solve reverse connection, NAT traversal, multi-node sessions, fleet execution, or automatic failover. Those remain later milestones.

## Minimal topology

```text
Browser
   |
   | HTTPS
   v
Orbit gateway / selector
   |
   | host identifies exactly one node
   v
Hub route proxy
   |
   | authenticated per-node Hub -> Node route
   v
Orbit route ingress on selected Node
   |
   | local/private forwarding
   v
DSH web runtime
```

The selector and every node route terminate at the same Orbit deployment. Nodes do not need their own public DNS records or public ingress.

## D1: Node identity and route authority are different things

The stable identity remains the RFC-0001 `nodeId`. A hostname, IP address, route URL, display name, or tunnel address is never identity.

For v0.4, the public browser route for a node is a deterministic projection of the node ID under the Orbit route domain:

```text
nodeId:      node_<32 lowercase hex>
route label: n-<same 32 lowercase hex>
example:     https://n-0123...cdef.dsh.example.com/
```

The display name remains mutable UI metadata and is never used for authorization or routing.

The deployment therefore needs a selector authority plus wildcard DNS/TLS for its route domain, for example:

```text
selector: dsh.example.com
routes:   *.dsh.example.com
```

v0.4 intentionally defines **no path-prefix routing mode** such as `/nodes/<id>/...`. DSH owns root-relative assets, API paths, WebSockets, cookies, and frontend behavior; path rewriting would couple Orbit to upstream internals.

v0.4 also defines no custom friendly route slug. The selector shows the friendly display name; the route authority stays deterministic and collision-free.

## D2: One operator-approved route target per node

A v0.4 node has zero or one active **route target**: the private/server-reachable origin where the Hub can reach that node's Orbit route ingress.

The target is mutable routing metadata, not node identity. Changing it keeps the node ID, history, reports, and credentials.

The route target is operator-approved. A node heartbeat or compatibility report may not make an arbitrary URL routable. This prevents a compromised node from turning the Hub into an SSRF proxy.

The minimal persisted facts are:

- `nodeId`;
- absolute route target origin;
- created/updated timestamps;
- last verified timestamp and current reachability result.

The storage implementation may use a dedicated table or equivalent normalized persistence. v0.4 does not need multiple candidates, weights, priorities, route discovery, or endpoint history beyond ordinary audit/event history.

Production route targets use HTTPS with normal certificate verification. Loopback HTTP is allowed only for local tests and development. v0.4 does not add a global "disable TLS verification" escape hatch.

## D3: Reachability becomes a Hub -> Node fact

RFC-0009 keeps `registryContact` and `reachable` separate. v0.4 activates `reachable` using the operator-approved route target only.

A route probe checks the Orbit route ingress, not a DSH-private endpoint. The probe proves:

1. the target is reachable over the configured transport;
2. the node route ingress identifies the expected `nodeId`;
3. the per-node Hub identity is accepted;
4. the Orbit route-ingress service is ready to accept routed traffic.

Default probe cadence is 60 seconds. Three consecutive failures move `reachable` to `unreachable`; one authenticated success restores `ok`. No target or no completed probe is `unknown`.

A route probe does not call DSH and does not change `registryContact`, compatibility, DSH health, or capabilities. Likewise a heartbeat never changes `reachable`.

## D4: Route eligibility is explicit and fail-closed

A node is openable through the selector only when all of the following are true:

- node state is `active`;
- an operator-approved route target exists;
- `reachable = ok`;
- the per-node Hub route identity is active;
- `web.routes` is present and backed by fresh compatibility evidence.

`registryContact` is displayed but is not an independent routing credential. A stale heartbeat may warn the operator, but it does not override the actual route probe or compatibility evidence.

A node that becomes ineligible while traffic is active fails closed. Orbit never silently sends that traffic to another node.

## D5: Hub -> Node route authentication is small and Orbit-owned

RFC-0008 owns the per-node Hub identity: one Ed25519 identity per node; the Hub private key never leaves the Hub; the node stores public material only; another node's Hub identity must fail.

v0.4 uses that identity only at the Orbit Hub -> Node boundary. It does not expose the key to DSH and does not depend on DSH authentication.

Each proxied HTTP request or WebSocket upgrade carries an `ORBIT-ROUTE-V1` proof. The signed UTF-8 string is exactly:

```text
ORBIT-ROUTE-V1
NODE_ID
ROUTE_AUTHORITY
METHOD
RAW_TARGET
TIMESTAMP
NONCE
```

There is no trailing newline. `RAW_TARGET` is the request target as received by the Hub (`path` plus query, without normalization). `ROUTE_AUTHORITY` is the deterministic public node authority from D1. `TIMESTAMP` uses Unix milliseconds and must be within 30 seconds of the node clock. `NONCE` is 128 random bits encoded as 32 lowercase hex characters.

Fixed transport headers are:

- `X-Orbit-Route-Node`;
- `X-Orbit-Route-Key`;
- `X-Orbit-Route-Timestamp`;
- `X-Orbit-Route-Nonce`;
- `X-Orbit-Route-Signature`.

The node verifies the expected node ID, public authority, active RFC-0008 key, timestamp, nonce, and signature before forwarding. A short in-memory nonce cache rejects duplicate proofs inside the timestamp window; route authentication does not add a persistent write for every browser request.

The body is deliberately not part of this signature. Hub -> Node transport **must use verified TLS**, which owns payload integrity, while `ORBIT-ROUTE-V1` establishes the authenticated Hub identity and exact route target without buffering arbitrary HTTP bodies. This keeps uploads and WebSocket streams streaming.

The Hub strips any browser/client-supplied `X-Orbit-Route-*` headers before creating its own proof. All route-auth headers are stripped before traffic reaches DSH and are treated as credential material for logging/redaction purposes.

Additional invariants:

- no fleet-wide shared credential;
- no node internal DSH/gateway secret is copied to the Hub;
- another node's Hub identity is rejected;
- rotation and revocation follow RFC-0008;
- a route request with a malformed/expired/replayed proof fails before DSH;
- the protocol authenticates an Orbit route request, not a DSH user or DSH session.

## D6: DSH is an opaque downstream runtime

The Hub route proxy does not parse or manufacture DSH sessions, model requests, settings RPCs, browser cookies, launch tokens, plugin routes, or WebSocket messages.

The node-local DSH compatibility adapter owns whatever is required for the **supported DSH version** to accept a request arriving from its Orbit route ingress. That adapter remains version-gated and fail-closed under the existing compatibility policy.

Consequences:

- a future upstream DSH native trusted-client/session-bootstrap primitive should replace downstream compatibility code without changing the Hub router;
- the router must not key behavior on DSH version numbers;
- tests assert user-visible route behavior, not private DSH function names or cookie names;
- third-party plugin-specific routing logic remains prohibited by ADR-0001.

`web.routes` is the gate between the fast-moving DSH side and the stable Orbit route side. If a DSH update breaks routed web behavior, compatibility evidence withholds `web.routes`; Orbit does not guess that the new version is safe.

## D7: HTTP and WebSocket forwarding

For an eligible node route authority, Orbit forwards the browser request to that node's route ingress while preserving ordinary HTTP semantics needed by DSH:

- method;
- raw path and query;
- request body as a stream where the runtime supports it;
- WebSocket upgrade and frames;
- status code and response body;
- DSH-set cookies scoped by the public node route authority.

Orbit may add and remove its own hop-by-hop authentication metadata at the Hub/Node boundary. It must not rewrite DSH paths to add a node prefix.

The public `Host`/authority presented to the node-local DSH adapter is the selected node's public route authority. This gives each node its own browser origin and keeps authority-bound upstream authentication isolated between nodes.

## D8: No automatic failover

v0.4 has exactly one route target per node and never redirects a failed node route to another node.

If the selected node becomes unavailable:

```text
selected node unavailable
        -> routed request fails closed
        -> Orbit presents a node-unavailable surface
        -> operator explicitly returns to the selector
        -> operator explicitly chooses another node
```

This is a safety invariant. Automatic failover could execute a setting change, prompt, terminal action, or workspace operation on the wrong machine.

## D9: Deletion, route changes, and audit

- Node deletion immediately makes its route ineligible and revokes its Hub identity.
- Route-target create/change/remove is an authenticated operator action and is audited.
- Hub identity provisioning, activation, rotation, and revocation are audited per RFC-0008.
- Reachability transitions are node health events.
- No route target or public route authority is ever reused as a replacement node's identity.

## Explicit non-goals

v0.4 does not implement:

- reverse-connected nodes or NAT traversal;
- automatic endpoint discovery;
- multiple route targets or priority/failover selection;
- path-prefix DSH routing;
- friendly per-node DNS aliases;
- a service mesh or general-purpose TCP tunnel;
- concurrent multi-node sessions in one Orbit UI;
- cross-node task execution;
- DSH-private authentication reimplementation in the Hub;
- third-party plugin routing rules.

## Acceptance

Architecture and implementation are acceptable only when a real two-node deployment proves:

1. selector authority lists both registered nodes from the Hub registry;
2. each deterministic node authority reaches only its bound node;
3. node A credentials/route identity cannot open node B;
4. HTTP root/assets/API and WebSocket traffic work through both routes for the supported DSH profile;
5. DSH cookies from node A are not used as node B's authority-bound cookies;
6. taking node A route ingress down makes A `unreachable` while B remains routable;
7. a request for A never fails over to B;
8. changing A's route target keeps A's node identity and history;
9. deleting A disables its route immediately;
10. an unsupported or stale DSH compatibility report withholds `web.routes` and disables Open without changing router code.
