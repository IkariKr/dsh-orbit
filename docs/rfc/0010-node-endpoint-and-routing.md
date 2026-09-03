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

Non-loopback production route targets use HTTPS with certificate and hostname/SAN verification. Trust comes from the platform trust store plus an optional operator-managed Orbit private-CA bundle; the bundle contains certificates only and may include an explicitly trusted self-signed leaf for a home/NAS deployment. There is no `skipVerify` mode and no per-request/browser/node-controlled trust input. Private RFC1918/ULA/Tailscale names and addresses are valid target classes because server-reachable private nodes are a primary v0.4 use case. Plain HTTP is permitted only for an explicit loopback/co-located route target where Hub and route ingress share the host trust boundary.

v0.4 intentionally does **not** build an SSRF sandbox around operator-selected private infrastructure. The security boundary is who may choose the target: only an authenticated operator may create/change it, while node heartbeat/report data and browser route input can never nominate or rewrite a target. This keeps the model compatible with NAS, LAN and Tailscale deployments without pretending that a Hub administrator is an untrusted URL source.

## D3: Reachability becomes a Hub -> Node fact

RFC-0009 keeps `registryContact` and `reachable` separate. v0.4 activates `reachable` using the operator-approved route target only.

A route probe checks an Orbit-owned route-ingress readiness surface, not a DSH-private API. The probe proves:

1. the target is reachable over the configured transport;
2. the node route ingress identifies the expected `nodeId`;
3. the per-node Hub identity is accepted;
4. the Orbit route-ingress service is ready to accept routed traffic;
5. the node-local compatibility adapter can currently establish its configured downstream transport to the DSH web runtime.

Item 5 is deliberately transport-level only. It may prove that the configured local DSH listener/process is connectable, but it must not parse a DSH private RPC, cookie, launch token, or frontend contract. Semantic DSH health remains report-derived.

Default probe cadence is 60 seconds. Three consecutive failures move `reachable` to `unreachable`; one authenticated success restores `ok`. No target or no completed probe is `unknown`. A DSH process death behind a still-running Orbit ingress therefore becomes `unreachable` through this same probe path rather than waiting for the seven-day report-staleness window. An already-routed request whose downstream connection fails still fails immediately; the health transition follows the normal probe threshold rather than being driven by browser traffic.

A route probe does not change `registryContact`, compatibility, `dshHealthy`, or capabilities. Likewise a heartbeat never changes `reachable`.

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

There is no trailing newline. `RAW_TARGET` is the exact request-target byte sequence handed from the public gateway to the Hub (`path` plus query). The Hub signs those bytes and forwards those same bytes without further normalization; the node ingress verifies against the exact raw target it receives before any downstream parsing. Gateway normalization that happens before the Hub therefore becomes the canonical input, but Hub signing and Hub→Node forwarding may not diverge. `ROUTE_AUTHORITY` is the deterministic public node authority from D1. `TIMESTAMP` uses **Unix milliseconds** and must be within 30 seconds of the node clock; this intentionally differs from the Unix-seconds field used by `ORBIT-MACHINE-V1`. `NONCE` is 128 random bits encoded as 32 lowercase hex characters.

Fixed transport headers are:

- `X-Orbit-Route-Node`;
- `X-Orbit-Route-Key`;
- `X-Orbit-Route-Timestamp`;
- `X-Orbit-Route-Nonce`;
- `X-Orbit-Route-Signature`.

The node verifies the expected node ID, public authority, active RFC-0008 key, timestamp, nonce, and signature before forwarding. A short in-memory nonce cache rejects duplicate proofs inside the timestamp window; entries are retained for at least 60 seconds, longer than the 30-second acceptance skew. Route authentication does not add a persistent write for every browser request.

v0.4 assumes one active Hub router instance for a Registry. It does not define HA/shared nonce state. A route-ingress process restart clears the in-memory nonce cache, so a captured still-fresh proof could be replayed inside the remaining 30-second timestamp window; v0.4 explicitly accepts this bounded residual risk because proofs travel only inside verified Hub→Node TLS, are redacted from logs, are bound to one node/authority/method/target, and are not browser-visible credentials. A future multi-Hub/HA milestone must replace this assumption with shared or epoch-bound replay state.

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

The Hub route proxy does not parse or manufacture DSH sessions, model requests, settings RPCs, cookie names/values or session semantics, launch tokens, plugin routes, or WebSocket messages. It may enforce generic HTTP metadata isolation such as the `Set-Cookie Domain` rule in D7.

The node-local DSH compatibility adapter owns whatever is required for the **supported DSH version** to accept a request arriving from its Orbit route ingress. That adapter remains version-gated and fail-closed under the existing compatibility policy.

Consequences:

- a future upstream DSH native trusted-client/session-bootstrap primitive should replace downstream compatibility code without changing the Hub router;
- the router must not key behavior on DSH version numbers;
- tests assert user-visible route behavior, not private DSH function names or cookie names;
- third-party plugin-specific routing logic remains prohibited by ADR-0001.

`web.routes` is the gate between the fast-moving DSH side and the stable Orbit route side. For v0.4, the proposed RFC-0009 extension requires both ordinary web-route evidence and a real WebSocket transport check before this capability is fresh. If a DSH update breaks routed HTTP or WebSocket behavior, compatibility evidence withholds `web.routes`; Orbit does not guess that the new version is safe.

## D7: HTTP and WebSocket forwarding

For an eligible node route authority, Orbit forwards the browser request to that node's route ingress while preserving ordinary HTTP semantics needed by DSH:

- method;
- raw path and query;
- request body as a stream where the runtime supports it;
- WebSocket upgrade and frames;
- status code and response body;
- downstream cookies after the generic isolation rule below.

Orbit may add and remove its own hop-by-hop authentication metadata at the Hub/Node boundary. It must not rewrite DSH paths to add a node prefix.

The public `Host`/authority presented to the node-local DSH adapter is the selected node's public route authority. This gives each node its own browser origin and keeps authority-bound upstream authentication isolated between nodes.

Cookie isolation is an Orbit HTTP-boundary rule, not DSH-specific session logic:

- the selector/Hub management session cookie remains host-only to the selector authority and is stripped defensively if it ever appears on a node-route request;
- the authenticated outer gateway must consume and strip its own authentication headers/cookies before forwarding a node-route request to the Hub router; gateway credentials never reach a Node;
- downstream `Set-Cookie` fields may keep their names, values, path, expiry, Secure/HttpOnly/SameSite attributes, but Orbit removes any `Domain` attribute before returning them to the browser, forcing them to be host-only for the selected node authority;
- Orbit does not inspect cookie values or key behavior on DSH cookie names.

This prevents a downstream `Domain=.dsh.example.com` cookie from escaping one node authority into the selector or sibling node authorities while remaining resilient to DSH changing cookie names.

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
5. a downstream `Domain=.dsh.example.com` cookie is returned as host-only and never appears on the selector or node B route; Orbit/gateway management credentials never reach either node;
6. taking node A route ingress down makes A `unreachable` while B remains routable;
7. stopping A's DSH process while keeping its Orbit ingress alive also makes A `unreachable` after the fixed probe threshold, and routed requests fail immediately rather than waiting for report expiry;
8. a request for A never fails over to B;
9. changing A's route target keeps A's node identity and history;
10. deleting A disables its route immediately;
11. an unsupported or stale DSH compatibility report withholds `web.routes` and disables Open without changing router code;
12. a private-CA route target succeeds only with the configured trust anchor and matching SAN; an untrusted certificate or wrong authority fails closed.
