# External UX reference: `dsh-remote-mobile`

Status: **Reference only — not an Orbit implementation or support claim**  
Observed: **2026-09-17**  
Target use: product and UX research for future Orbit milestones  
Source: [IceApriler/dsh-remote-mobile](https://github.com/IceApriler/dsh-remote-mobile)

## Summary

`dsh-remote-mobile` is a DSH plugin that combines remote Web access, mobile
browser adaptation, device/session management, and QR-based pairing in the DSH
Settings surface. Its strongest product lesson for Orbit is not the particular
gateway implementation; it is the low-friction loop of **see the device, scan to
pair, observe connection state, and revoke access without leaving the DSH
interface**.

This document records an external project and the possible UX implications for
Orbit. It does not make a security, compatibility, release, or production claim
about either project. External claims are treated as observations to validate,
not as trusted inputs or authorization to change Orbit contracts.

## Source record

| Source | Type | Version or status | Observation |
| --- | --- | --- | --- |
| [GitHub repository](https://github.com/IceApriler/dsh-remote-mobile) | source and documentation | latest source v1.7.0; latest commit `68ab464` | observed 2026-09-17 |
| [npm package](https://www.npmjs.com/package/dsh-remote-mobile) | distribution | npm `latest` was v1.7.0 | observed 2026-09-17 |
| [GitHub issues](https://github.com/IceApriler/dsh-remote-mobile/issues) | user feedback | issues #1–#5 closed; #6 open in the public API snapshot | observed 2026-09-17 |
| [GitHub releases](https://github.com/IceApriler/dsh-remote-mobile/releases) | release history | releases visible through v1.6.0; v1.7.0 was present in source/npm but not yet synchronized as a GitHub release | observed 2026-09-17 |

The public repository showed 17 stars, 4 forks, 1 open issue, and one principal
contributor at the time of observation. These are small-scale signals. The
useful evidence is the specificity of the feedback: real mobile layout and
touch regressions led to concrete follow-up releases. It should not be
interpreted as broad community validation.

## Observed project functionality

### DSH-native entry point

The plugin registers a **Remote & Mobile** section in DSH Settings rather than
requiring a separate administration site. Its client bundle uses DSH's settings
extension surface and keeps the remote-access controls beside the rest of the
DSH configuration.

### Device visibility and revocation

The settings surface displays authorized browser devices with information such
as device type, operating system/browser, source IP, authentication method, and
last activity. It supports single-device revocation and revocation of all
sessions. Security statistics expose failed attempts, lockout state, and recent
activity.

This is the important user-facing loop:

```text
open DSH Settings
  -> see authorized devices
  -> identify an unfamiliar device or stale session
  -> revoke one device or all devices
  -> observe the updated state
```

### QR and one-time pairing

The desktop settings page can generate a short-lived six-digit pairing code and
an address/QR entry point for a phone. The observed implementation uses a
five-minute, single-use code and exchanges successful pairing for a persistent
browser session. The QR flow is designed to avoid copying a long address or
credential by hand.

For Orbit, the transferable idea is **one-time bootstrap UX**. The lifetime,
credential format, and token transport must be designed independently under an
Orbit authentication contract.

### Real-time status

The plugin uses Server-Sent Events for device-connected, device-online,
device-revoked, and security-alert updates, with periodic status refresh as a
fallback. The settings page can therefore show a newly paired phone without
requiring a manual reload.

### Mobile Web adaptation

The project reuses the DSH Web application rather than building a separate
mobile backend. Its presets adapt:

- the sidebar into a touch-friendly drawer;
- settings dialogs into a narrow-screen, vertically scrollable layout;
- tabs and controls to avoid text wrapping and accidental overflow;
- conversation content, code blocks, and composer controls for small viewports;
- touch interactions where desktop hover is unavailable.

Issues #5 and #6 show why this needs regression coverage: a change to the
upstream three-column Grid and right sidebar caused transparent layers to cover
the conversation area and intercept touch events. The fix was driven by a
reproducible viewport and DOM/layout diagnosis, not only by a screenshot.

### Diagnostics and coexistence

When another remote-access plugin owns a shared service, the plugin attempts to
avoid a fatal startup collision, exposes the conflict in Settings, and offers a
copyable diagnostic report. This is a useful example of making an operational
failure actionable for the user.

## What Orbit can borrow

### 1. Put the device workflow where the user already works

Orbit should prefer a first-class **Devices and Nodes** view in the authenticated
Hub/operator surface. If DSH later exposes a stable, generic settings extension
contract, an Orbit card could also be discoverable from DSH Settings. Until then,
Orbit must not patch DSH private frontend components or third-party plugin
bundles merely to place a control there.

The view should answer, without leaving the current control surface:

- Which browser sessions are active?
- Which DSH nodes are enrolled?
- Which node is currently selected?
- Why is a node unavailable or not routable?
- How do I revoke a session, delete a node, or start a new enrollment?

This extends the existing [Registry operator UI](../registry-ui.md) and the
selector behavior in [RFC 0011](../rfc/0011-browser-node-selection.md); it does
not replace either contract.

### 2. Make QR bootstrap a deliberate, one-time action

A future Orbit QR flow could make first enrollment or operator-device setup
much easier:

```text
Hub/operator surface
  -> create short-lived, single-use bootstrap
  -> show QR for one public authority and target scope
  -> user scans and confirms the target
  -> establish the intended session or enrollment
  -> invalidate bootstrap and record an audit event
```

The QR should carry only the minimum short-lived bootstrap information. It must
not carry a Hub private key, Node private key, internal proxy secret, a
fleet-wide DSH cookie, or a long-lived bearer credential.

### 3. Distinguish browser devices from DSH nodes

The external project uses “device” primarily for an authorized browser session.
Orbit has a richer model:

| Orbit object | Meaning | Examples of visible state |
| --- | --- | --- |
| Operator/browser session | a person using a browser or future mobile client | principal, last activity, session expiry, revoke status |
| DSH node | an enrolled machine/runtime | `nodeId`, DSH/Orbit version, heartbeat, health, compatibility, reachability |
| Route authority | the public authority for exactly one node | selected authority, route availability, cookie scope |

The UI may present these together, but it must not treat a browser session as a
node identity or an IP address/display name as a node identity. The stable
identity and route rules remain those of the Registry and [RFC 0011](../rfc/0011-browser-node-selection.md).

### 4. Show independent state and explain failures

The external project makes device and security changes visible in one place.
Orbit should extend its existing per-dimension status model rather than collapse
it into a single “online” badge. A node card should preserve distinctions such
as:

- registry contact;
- authenticated state;
- DSH health;
- Orbit compatibility;
- route reachability;
- active capabilities;
- deleted/tombstoned state.

An unavailable node should remain identifiable as the selected target and offer
a route back to the selector. It must not silently display another node.

### 5. Use real-time updates with a recoverable fallback

SSE or an equivalent event channel can improve the operator experience for
enrollment, heartbeat, revocation, and capability changes. A periodic refresh
should remain a consistency fallback. Neither event loss nor a stale client view
may change server-side eligibility or authorization.

### 6. Treat mobile behavior as a tested interaction surface

Useful Orbit test cases include:

- narrow viewport node list and status density;
- touch-safe selection and confirmation controls;
- clear target authority after navigation;
- reconnecting to the same node after a transient disconnect;
- returning to the selector before choosing another node;
- no cross-node cookie or WebSocket retargeting;
- visible, target-preserving unavailable states;
- explicit confirmation for deletion, revocation, and multi-node actions.

These should be behavior tests and real browser evidence, not selectors copied
from a third-party plugin's private DOM.

## What Orbit must not copy

The external project solves a single-machine DSH problem by opening the DSH Web
server externally and virtualizing authorized external requests as loopback.
That is not Orbit's trust model.

Orbit must not:

- expose the DSH service directly on `0.0.0.0` as a substitute for an
  authenticated gateway;
- treat LAN/Tailscale membership as a replacement for operator authentication;
- rewrite external `Host`, `Origin`, `Sec-Fetch-Site`, or socket identity to
  make a request appear to be loopback;
- copy DSH cookies or launch tokens between node authorities;
- use a long-lived URL/bearer token as a fleet-wide credential;
- let a mobile client call the private `/api/v1/*` machine API;
- put gateway secrets, route private keys, or Node private keys in a browser or
  mobile client;
- trust client-supplied identity or `X-Forwarded-*` headers as authority;
- weaken TLS CA/SAN verification, Origin/CSRF checks, or host-only cookie
  isolation for convenience;
- add branches for a named third-party plugin, private API, package path, or
  CSS selector;
- introduce silent cross-node failover or implicit broadcast.

The relevant Orbit boundaries are documented in the [architecture](../architecture.md),
[security model](../security-model.md), [third-party plugin boundary](../adr/0001-third-party-plugin-boundary.md),
and [public origin authority ADR](../adr/0002-public-origin-authority-boundary.md).
A UX reference is not an exception to those contracts.

## Device and node UX direction for Orbit

The recommended product shape is:

```text
Authenticated Orbit Hub
  └─ Devices and Nodes
      ├─ operator/browser sessions
      ├─ enrolled DSH nodes
      ├─ node health, compatibility and route eligibility
      ├─ QR/bootstrap entry point
      ├─ revoke session / delete node / reenroll node
      └─ audit and target-scope explanation
```

The selector remains the primary discovery and switching surface. A node route
remains a complete, deterministic authority for one node. A device view can
make those relationships easier to understand, but it must not create a global
`activeNode` or change an existing WebSocket's target.

## Recommended roadmap placement

The following sequence is deliberately aligned with the existing
[Roadmap](../roadmap.md). It is a recommendation, not an authorization to add
scope to the current release closure.

| Milestone | Recommended UX work | Prerequisites and gates | Explicit boundary |
| --- | --- | --- | --- |
| Current v0.4 release closure / v0.4.x | Keep this as research and contract documentation only: document device-vs-node concepts, selector states, QR usability goals, and mobile browser acceptance cases. Improve wording and information architecture only where it does not alter the frozen route contract. | Current release closure must remain independent; any authority, authentication, or transport change requires its own review and evidence. | No mobile pairing protocol, reverse tunnel, new DSH auth bypass, or release-status claim. |
| 0.5 reverse-connected nodes | Add secure pairing/device authorization for NAT-restricted devices. Use QR as a short-lived bootstrap UX for an explicitly selected target and enrollment scope; show presence and reconnect state. | New reverse-connection and pairing protocol; threat model; RFC/ADR review; TLS and credential lifecycle; positive and negative mounted/runtime evidence; explicit revocation and replay tests. | Do not turn QR into a long-lived bearer token; do not expose machine ingress; do not infer identity from IP or QR contents; do not add fleet execution. |
| 0.6 multi-node sessions | Add a unified Devices and Nodes view, browser-session visibility, per-node session indicators, clear target scope, and mobile-friendly selector/session navigation. Provide real-time updates with polling or refresh fallback. | RFC-0011-compatible authority behavior; host-only cookie and WebSocket isolation; explicit target-scope model; browser/mobile tests for reconnect and node switching; no-silent-failover evidence. | No global active node, cross-node session migration, implicit broadcast, or automatic retargeting after failure. |
| 0.7 fleet workflows | Put node selection, capabilities, target scope, confirmation, progress, results, and audit into explicit task workflows. Make the affected nodes visible before execution and in the final record. | A fleet workflow protocol and likely RFC/ADR; capability evidence; authorization and audit model; per-target negative tests; real multi-node evidence. | No background execution against unspecified nodes and no “best node” choice that hides the actual target set. |

`0.5` is the earliest roadmap stage where the existing roadmap explicitly
places pairing for NAT-restricted devices. `0.6` is the natural stage for
cross-node session and target-scope UX. `0.7` is the right stage for task-level
selection and audit rather than embedding fleet controls into the selector.

## Acceptance expectations for future work

Any implementation derived from this reference should prove, at minimum:

1. the UI identifies whether an item is a browser session or a DSH node;
2. QR/bootstrap material is short-lived, single-use, target-scoped, and revoked
   after use or cancellation;
3. the selected node authority remains visible through navigation and failure;
4. a failed node never serves another node's response;
5. browser sessions and DSH node identities remain independently revocable;
6. management credentials and machine credentials do not reach DSH routes or the
   browser client;
7. Origin, CSRF, TLS, cookie isolation, and route eligibility remain enforced;
8. reconnect stays within the same target authority;
9. multi-node operations show explicit targets and never broadcast implicitly;
10. evidence identifies the exact Orbit/DSH candidate and records negative cases,
    not just a successful page load.

If implementation changes node identity, public authority, BrowserAuth/DSH
session semantics, reverse connection, machine protocol, capability meaning,
or multi-node execution scope, stop and create or update the relevant RFC/ADR
before construction. The feature is not implemented, verified, released, or
promoted merely because this reference exists.

## References

- [DSH Orbit roadmap](../roadmap.md)
- [Architecture](../architecture.md)
- [Security model](../security-model.md)
- [Registry operator UI](../registry-ui.md)
- [RFC 0011: Browser node selection](../rfc/0011-browser-node-selection.md)
- [ADR-0001: Third-party plugin boundary](../adr/0001-third-party-plugin-boundary.md)
- [ADR-0002: Ingress Authority Boundary](../adr/0002-public-origin-authority-boundary.md)
- [IceApriler/dsh-remote-mobile on GitHub](https://github.com/IceApriler/dsh-remote-mobile)
- [dsh-remote-mobile on npm](https://www.npmjs.com/package/dsh-remote-mobile)
