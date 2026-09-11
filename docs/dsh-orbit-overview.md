# DSH Orbit overview

**One authenticated entry point in front of many DeepSeek Harness nodes, with every routing decision explicit and fail-closed.**

DSH Orbit is a community-maintained, self-hosted control and routing layer for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It
does not fork DSH and does not replace it: DSH keeps owning agents, sessions,
settings, plugins, and workspaces on each machine, and Orbit owns the layer that
decides *who may reach which node, and under which conditions*.

> DSH Orbit is an independent community project. It is not affiliated with or
> endorsed by DeepSeek AI.

---

## The problem

Self-hosting DeepSeek Harness is a local-first experience: one machine, one
workspace, and a web surface that assumes a trusted local client. It gets
awkward as soon as you want more than that.

- You want to reach DSH from a browser outside the machine **without exposing
  DSH itself** to the internet.
- You have **more than one machine** — a workstation, a home-lab box, a GPU
  host — and you want one place to reach them.
- You want DSH upgrades to be a **decision**, because an upstream release can
  change the source layout your deployment depends on.
- You do not want a proxy that quietly routes you to *some* node when the one
  you asked for is down.

Orbit addresses those four things, and it stays deliberately narrow while doing
it.

---

## What v0.4 gives you

| Capability | What it means in practice |
| --- | --- |
| **Endpoint Selector** | One entry point at the route domain apex lists your enrolled nodes and links to each one. |
| **Deterministic per-node authority** | Selecting a node navigates to `n-<nodeId>.<routeDomain>` — a stable address derived from node identity, not a session flag. |
| **Signed hop-by-hop routing** | The Hub proves its identity to the node with an `ORBIT-ROUTE-V1` signature; the node verifies it before forwarding. No request-body buffering. |
| **Operator-assigned route targets** | One server-reachable destination origin per node, with reachability derived by the Hub rather than declared by the node. |
| **Five-condition eligibility** | A node is routable only when `state=active`, `authenticated=ok`, `dshHealthy=ok`, `orbitCompatible=pass`, and `reachable=ok` all hold. |
| **No silent failover** | An unavailable node fails closed with a generic error. Traffic is never redirected to a different node behind your back. |
| **Browser context isolation** | Host-only cookies keep sessions from leaking across distinct DSH instances. |
| **Full duplex routing** | HTTP and WebSocket traffic is proxied opaquely, without DSH path rewriting. |
| **Registry control plane** (v0.3) | Enrollment with single-use tokens, stable node identity, heartbeat contact tracking, deletion with tombstone reenrollment, and evidence-backed capabilities. |
| **Upgrade guard** (v0.2) | A candidate DSH build is validated against copied data on an isolated endpoint before anything reaches production. |

---

## How it fits together

```text
Browser
   |
   |  HTTPS (selector apex + wildcard *.routeDomain)
   v
Authenticated gateway            <- terminates TLS, authenticates the operator,
   |                                injects an internal secret the browser never holds
   v
Hub  (control plane, loopback only)
   |   browser API + selector + router
   |
   |  ORBIT-ROUTE-V1 signed hop
   v
Node RouteIngress  ->  DSH runtime   (one per machine)
   ^
   |  heartbeat, compatibility reports
   |  private machine ingress, internal listener, never host-published
```

The Hub is a control plane. DSH remains the execution runtime on each node. The
browser path and the private machine path are separate surfaces with separate
authority.

---

## Security posture

- **Fail closed.** Unknown upstream layouts, patch mismatches, missing
  credentials, and unverifiable routing conditions stop the path instead of
  weakening it.
- **No TLS bypass.** The project's own contract tests forbid
  `rejectUnauthorized=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, and
  `--ignore-certificate-errors` in both the runtime and the acceptance harness.
- **The browser never holds the internal secret.** The gateway injects it after
  authenticating the operator; exposing it to a client would itself be a
  failure.
- **The control plane is not public.** The Hub binds loopback, and the private
  machine ingress is an internal listener that is not published to the host.
- **Capabilities cannot be self-advertised.** The Hub derives them from uploaded
  compatibility evidence, so a node cannot claim a feature it has not proven.
- **Node failure is not a routing event.** Outages produce a fail-closed
  response, not a fallback to another node.

See [Security model](security-model.md) for the trust boundary and deployment
requirements.

---

## Compatibility posture

- **One pinned baseline per release.** Orbit `v0.4.x` targets DSH `0.1.1-rc.2`,
  and the release attestation records the upstream commit SHA and CLI digest.
- **Capability binding, not just version matching.** Compatibility is version
  *and* validated capabilities, defined by `CAPABILITY_EVIDENCE` in
  `src/registry/capabilities.mjs`.
- **Orbit does not chase every DSH release candidate.** Adoption is an explicit,
  validated decision — see [DSH version policy](dsh-version-policy.md).
- **New upstream releases are classified, not adopted.** A scheduled workflow
  checks the published DSH package and classifies it as `supported` or
  `unknown`; it never changes a registry or a deployment on its own.
- **Some capabilities are never claimed.** `terminal.pty` and `agents.run` have
  no automated runtime evidence and are not claimable.

See [Compatibility](compatibility.md) for the tested-version table.

---

## Governance and evidence

The project treats its own claims as things that have to be provable.

- **Contracts before code.** Eleven RFCs define node identity, enrollment,
  machine API, capability contract, and endpoint routing; ADRs record boundary
  decisions such as the third-party plugin boundary.
- **Operational runbooks.** SOPs cover enrollment, selector operation,
  backup/restore, and production promotion/rollback.
- **Attested releases.** A release is a candidate commit, a mounted two-node
  drill, and an evidence-only closure commit whose parent is that exact
  candidate. Pre-release validation includes a two-node browser drill with
  per-node selector opens, cookie isolation, HTTP and WebSocket A/B routing,
  gateway and Hub restart recovery, fail-closed node outage, DSH loss and
  recovery, and delete/bookmark/reenroll.
- **No hand-written evidence.** Acceptance artifacts are emitted by the runner
  that performed the run, and the mounted smoke artifact is hash-bound to the
  raw record it was derived from.
- **Zero runtime dependencies.** The test suite runs on Node's built-in test
  runner.

---

## Status and scope

- `v0.4.0-rc.1` is published as a **pre-release**. Production promotion is not
  authorized and requires a separate gate.
- **In scope for v0.4:** the selector and routing layer described above, on top
  of the v0.3 registry control plane.
- **Out of scope:** reverse-connected nodes, NAT traversal, reverse tunnels,
  fleet execution, and concurrent multi-node sessions.

> **Reverse-connected nodes are not part of v0.4. They remain a v0.5 scope.**

See [Roadmap](roadmap.md) for what each milestone adds.

### Who this is for

Operators who self-host DSH on server-reachable machines and want explicit,
auditable remote access and multi-node routing — and who prefer a control plane
they can read, test, and run themselves.

### Who this is not for

If you want a managed service, a general-purpose tunnel, NAT traversal for
devices behind carrier-grade NAT, or a web terminal multiplexer, Orbit is the
wrong tool — see [How DSH Orbit compares](comparison.md) for what to use
instead.

---

## Start here

| Document | Use it for |
| --- | --- |
| [Architecture](architecture.md) | Component boundaries and the implemented v0.3/v0.4 topology. |
| [Security model](security-model.md) | Trust boundary and deployment requirements. |
| [Registry deployment](registry-deployment.md) | Topology, startup/shutdown, restart drills, isolation contract. |
| [Compatibility](compatibility.md) | Tested DSH versions and what "supported" requires. |
| [DSH version policy](dsh-version-policy.md) | Long-term baseline, patch/minor update rules, capability binding. |
| [Comparison](comparison.md) | How Orbit relates to tunnels, VPNs, and web terminals. |
| [Configuration reference](configuration-reference.md) | Every environment variable. |
| [Upgrade guide](upgrade.md) | The candidate → verify → promote workflow. |
| [Roadmap](roadmap.md) | Milestones 0.5 through 0.7. |
| [Troubleshooting](troubleshooting.md) | Known failure modes and diagnostics. |
| [Release attestations](release-attestations/) | Per-release evidence records. |

For deployment steps, start with the [README](../README.md#quick-start).
