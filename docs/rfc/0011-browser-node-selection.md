# RFC 0011: Browser node selection for v0.4

Status: **Accepted for v0.4 construction (2026-09-03)** after architecture review and remediation at `7b3960f`.

Depends on: RFC-0007 browser management API, RFC-0009 health/capability semantics, RFC-0010 node endpoint and routing model.

## Goal

The user enters Orbit through one familiar selector URL, sees registered DSH nodes and their current eligibility, explicitly chooses one, and then uses that node's ordinary DSH web surface.

v0.4 intentionally avoids a mutable global `activeNode` stored in the Hub or browser session. Selection is represented by navigation to the selected node's deterministic route authority from RFC-0010.

## D1: Selector and node routes use separate authorities

Example deployment:

```text
https://dsh.example.com/
    Orbit selector

https://n-<node-id-hex>.dsh.example.com/
    selected DSH node routed through Orbit
```

The selector authority never proxies ordinary DSH traffic. A node route authority maps to exactly one `nodeId`.

This authority-based selection is deliberate:

- DSH keeps its root path; no path-prefix rewrite is required;
- browser cookies remain naturally scoped by node authority;
- HTTP and WebSocket routing use the same node key;
- separate tabs can open different nodes without fighting over one shared `activeNode` cookie;
- a DSH authentication implementation can evolve without Orbit teaching the selector its cookie/token details.

The generated node authority is routing metadata, not a second node identity.

## D2: Selection is explicit navigation, not a hot swap

Choosing a node performs a full navigation to that node's route authority.

Switching from node A to node B means returning to the selector or choosing a selector action that navigates to B. Orbit does not mutate an existing DSH page in place and does not retarget an already-open WebSocket from A to B.

This keeps execution scope visible in the browser origin and eliminates cross-node hot-swap races.

v0.4 does not promise a single-tab seamless transition. A normal navigation is the intended behavior.

## D3: Selector state comes from the Registry

The selector lists registered nodes using the Hub's authoritative data. Each row should expose, at minimum:

- display name when configured, otherwise node ID;
- node state;
- DSH version;
- Orbit version;
- `registryContact`;
- `reachable`;
- compatibility state;
- active capabilities relevant to opening the web route.

The selector does not re-derive health in JavaScript and does not infer support from a DSH version string.

The `Open` action is enabled only when RFC-0010 route eligibility passes. Ineligible nodes remain visible with a concise reason instead of disappearing.

Examples of reasons:

- no route target configured;
- route target/route ingress/DSH downstream transport unreachable;
- Hub route identity not active;
- `web.routes` unavailable or stale;
- node deleted/tombstoned.

## D4: Authentication layers remain separate

Orbit edge authentication protects the selector and node route authorities. The gateway must continue to strip client-supplied identity/proof headers and inject only gateway-controlled operator identity, following RFC-0007. Credentials used by that gateway, including its own authentication cookies/headers, are consumed at the gateway and must not be forwarded into a node route.

The selector/Hub management session remains host-only to the selector authority; the node router strips it defensively if presented. RFC-0010 additionally removes any downstream `Set-Cookie Domain=` attribute so DSH cookies become host-only to the selected deterministic node authority. This is generic cookie isolation: Orbit does not inspect DSH cookie names or values.

DSH may also require its own browser session/authentication for the selected authority. That behavior belongs to the node-local DSH compatibility adapter and the supported DSH profile, not to the selector.

Orbit must not:

- copy a DSH cookie from one node authority to another;
- parse a DSH launch token to decide which node is selected;
- create one fleet-wide DSH login cookie;
- weaken DSH authentication merely because the user already authenticated to Orbit.

If upstream DSH later exposes a generic authenticated-gateway session bootstrap, the node-local adapter may use it without changing selector semantics.

## D5: Failure is visible and target-preserving

If a node route becomes unavailable while its page is open, Orbit must preserve the target identity in the failure surface.

The response should say, in effect, "this selected node is unavailable" and offer a route back to the selector. It must not quietly show another node's DSH page under the failed node authority.

No automatic cross-node fallback exists in v0.4.

If the Hub restarts, existing proxied WebSockets may close and the DSH page may reconnect normally to the same node authority. The Hub must not use restart as a reason to select a different node.

## D6: Direct node-route bookmarks are allowed

A user may bookmark a deterministic node route authority and open it directly. The same edge authentication and route eligibility checks apply.

If the node is no longer eligible, the route returns an Orbit-owned unavailable response with a link to the selector. Direct bookmarks do not bypass Registry state.

The selector remains the primary discovery and switching UI; bookmarks are a convenience, not a separate registration mechanism.

## D7: Node deletion and reenrollment

Deleting a node makes its route authority unroutable immediately.

Reenrollment that restores the same RFC-0005 node ID restores the same deterministic route authority. It does **not** reactivate the deleted-era Hub route identity: RFC-0008 provisions a fresh per-node Hub route identity after reenrollment, while old Hub route keys remain revoked. The operator must still have a valid route target, newly active Hub route identity, `reachable = ok`, and fresh `web.routes` before Open becomes available again.

Ordinary enrollment of a replacement installation receives a new node ID and therefore a different route authority.

## D8: Migration from the current single-node public entry

A v0.3 deployment may currently route the selector candidate authority directly to one DSH node, for example `dsh.example.com -> NAS DSH`.

v0.4 promotion changes that authority's role:

```text
before: dsh.example.com -> one DSH node
v0.4:   dsh.example.com -> Orbit selector
        n-<node>.dsh.example.com -> selected DSH node through Orbit
```

The old node is not renamed or re-enrolled; only its browser route changes. Its stable `nodeId`, Registry history, compatibility evidence, and route target remain the same.

Candidate validation must use a separate rehearsal selector/wildcard authority so production traffic is not taken over during construction. Production promotion switches the selector/gateway only after the existing production node has passed its deterministic node-route smoke. Rollback restores the previous single-node gateway mapping; it does not rewrite node identity.

## D9: UX scope for v0.4

The selector is intentionally small. It needs to answer only:

1. Which nodes do I have?
2. Which ones can I open now?
3. Why can I not open this one?
4. Open the selected node.
5. Return here and choose another node.

v0.4 does not add fleet dashboards, aggregated sessions, multi-node command bars, background task orchestration, or topology editors.

Route-target administration may live on the existing node-detail management surface rather than inside the selector itself.

## DSH evolution rule

Tests and UI wording must describe behavior, not private upstream implementation. In particular, v0.4 docs and selector tests should not freeze:

- DSH cookie names;
- DSH token parameter names;
- exact DSH RPC endpoint inventory;
- upstream frontend component structure;
- plugin package names.

The selector relies on the stable Orbit concepts `nodeId`, route eligibility, health, and `web.routes`. The compatibility layer absorbs DSH-specific churn.

## Explicit non-goals

v0.4 browser selection does not provide:

- one mutable Hub-wide active node;
- automatic failover;
- path-prefix embedding of DSH;
- iframe composition of multiple DSH instances;
- one page connected to multiple nodes at once;
- cross-node session migration;
- cross-node cookie/session synchronization;
- user-defined route aliases.

## Acceptance

A real browser test with two routable nodes must prove:

1. opening the selector lists A and B with independently derived state;
2. clicking A navigates to A's deterministic authority and reaches A only;
3. clicking B in another tab navigates to B and does not retarget the A tab;
4. DSH root/assets/API/WebSocket behavior works on both authorities for the supported compatibility profile;
5. stopping A's DSH process while its Orbit ingress remains alive makes A become visibly unavailable after the route-probe threshold rather than remaining openable until report expiry;
6. a downstream parent-domain cookie attempt from A cannot leak that cookie to the selector or B, and gateway/Orbit management credentials never reach either node;
7. disabling A makes A visibly unavailable while B remains openable;
8. no A request is served by B during failure;
9. returning to the selector and choosing B is an explicit user action;
10. deleting A disables direct bookmarks to A immediately;
11. reenrolling A keeps its deterministic route authority but requires a fresh Hub route identity before Open returns;
12. an unsupported DSH update can disable `web.routes`/Open without a selector code change.
