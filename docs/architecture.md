# Architecture

**Orbit understands DSH, not the DSH plugin ecosystem.**

DSH Orbit is designed as a layer around DeepSeek Harness rather than a fork of it.

## Current components

### Upstream runtime

DeepSeek Harness remains the runtime that owns agents, settings, plugins, workspaces, and local execution.

### Compatibility layer

The compatibility patch adjusts the DSH browser trust check and privileged API trust check for one explicitly configured, authenticated reverse-proxy origin.

The patch is applied in two places because a DSH web profile can contain its own copy of `@deepseek-ai/dsh-client-connection`:

- the globally installed package during image build;
- the profile-local package before the externally reachable web process is marked ready.

### Gateway

The gateway authenticates the user and injects an internal secret that is not available to the browser. The DSH compatibility layer requires that secret in addition to host, protocol, and same-origin checks.

### Upgrade guard

Compatibility is tied to explicit upstream versions. Candidate builds fail when the expected DSH source layout changes.

## Fresh-profile bootstrap

On a new data directory, DSH may need to create and install its web profile before the profile-local client package exists.

The example entrypoint handles this without exposing the bootstrap process:

1. start DSH internally;
2. wait for the profile-local client package;
3. stop the bootstrap process;
4. apply the runtime patch;
5. restart DSH;
6. verify the global and profile-local patches;
7. mark the container healthy;
8. allow the gateway container to start.

## Third-party plugin boundary

DSH Orbit supports and integrates with DeepSeek Harness itself. Orbit core does not patch, fork, version-pin, adapt, or maintain compatibility logic for third-party DSH plugins.

Expectations:

- Issues in DSH core may be located, reproduced, reported upstream, and — when the fix is general enough — contributed as a pull request. Orbit may keep a minimal, version-pinned, fail-closed temporary DSH compatibility patch only while upstream converges, with explicit exit conditions.
- Issues in third-party plugins are outside Orbit's responsibility: Orbit does not fix, patch, fork, report, or track them, and Orbit does not know or depend on any plugin's package name, version, install path, source layout, or private API. Whether a third-party plugin supports remote access, headless operation, trusted proxies, persistence, or anything else is the plugin author's and the operator's responsibility.
- Orbit may expose generic infrastructure primitives that third-party plugins can choose to support — the authenticated reverse-proxy trust boundary, public-host admission, generic runtime hooks, generic capability discovery, the upgrade/rollback guard, compatibility evidence, and future fleet routing and node management. These primitives must not contain conditionals on specific third-party plugins.

Prohibited in Orbit core:

- `if plugin == <name>` branches;
- third-party package names as knobs, paths, or assumptions;
- plugin version pins;
- third-party `node_modules` paths;
- third-party source matchers;
- third-party bundle patches;
- plugin-specific smoke suites.

Existing plugin-specific compatibility code (the `@linxin666/dsh-ssh` terminal fence patch and related configuration, smoke, and tests) is treated as legacy third-party compatibility debt: it is freeze-only, marked as such in the code, and removed once DSH itself provides a sufficiently generic trusted-client / authenticated-proxy capability. See `docs/third-party-debt.md`.

## Implemented v0.3 Registry MVP topology

The v0.3 release candidate implements the private Registry Hub/Node control
plane described by the frozen RFCs:

```text
Browser --HTTPS--> authenticated gateway --> Hub (loopback browser API)
                                             ^
                                             |
Node A/B --private machine ingress----------+
       |
      DSH runtime per node
```

The Hub manages enrollment, identity keys, heartbeat contact, compatibility
reports, evidence-backed capabilities, browser sessions, deletion, and
operator-assisted tombstone reenrollment. DSH execution remains on each node.
The browser gateway and private machine ingress are separate paths; `/api/v1/*`
is not browser-proxied and the Hub does not bind publicly.

Capabilities are **Hub-derived, evidence-backed feature assertions**. Nodes do
not advertise capabilities, and reports do not restore heartbeat contact. See
`docs/registry-mvp.md`, `docs/registry-deployment.md`, and the frozen RFCs for
the contract details.

## Implemented v0.4 Endpoint Selector & Routing Architecture

The v0.4 release candidate implements the Endpoint Selector and routing layer
over the accepted Registry:

```text
Browser --HTTPS (wildcard *.routeDomain)--> authenticated gateway --> Hub Router (loopback)
                                                                       ^
                                                                       | ORBIT-ROUTE-V1 (signed)
                                                                       v
                                                                 Node RouteIngress
                                                                       | loopback
                                                                      DSH
```

The selector entrypoint lives at the route domain apex (e.g. `dsh.example.com`).
Selecting an eligible node navigates to its deterministic authority
`n-<nodeId>.<routeDomain>`. Wildcard DNS and TLS terminate at the outer gateway.
Host-based selection keeps DSH at `/`, enforces host-only cookie isolation, and
eliminates global mutable active-node session state.

The Hub stores one operator-approved server-reachable route target per node. It
authenticates to the node-side RouteIngress using per-node Ed25519 route keys
(`hub_route_keys`, RFC-0010 / RFC-0008), forwarding HTTP and WebSocket traffic
opaquely. The Hub router does not inspect private DSH application state. A node
is routable only when all five deterministic conditions are met (`state=active`,
`authenticated=ok`, `dshHealthy=ok`, `orbitCompatible=pass`, `reachable=ok`).

**No silent failover**: an unavailable node fails closed immediately.

> **Reverse-connected nodes are not part of v0.4. They remain a v0.5 scope.**
> NAT traversal, reverse tunnels, and fleet-wide execution remain future milestones.

## Explicitly out of scope for the implemented v0.4 release

Reverse connections, NAT traversal, multi-node concurrent sessions, fleet
execution, and third-party plugin compatibility remain outside v0.4. Existing
third-party compatibility debt remains freeze-only. See `docs/roadmap.md` and
`docs/third-party-debt.md`.
