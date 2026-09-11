# How DSH Orbit compares

DSH Orbit sits in a specific place: an **application-layer control and routing
plane for self-hosted DeepSeek Harness nodes**. Most tools people reach for
first solve a *different* layer, so this page is about which layer you actually
need.

> How to read this page: the alternatives below are described by **category**,
> at a level that holds broadly, because individual tools change over time.
> This is orientation, not a feature audit — check each project's own
> documentation before deciding. Reviewed 2026-09-11; corrections are welcome
> through Discussions or an issue.

---

## Short version

- **One DSH instance, one operator, just needs remote access?** A reverse proxy
  with an identity-aware access layer is enough. Orbit is unnecessary weight.
- **Many DSH machines, or routing decisions you must be able to audit?** That is
  the problem Orbit exists for.
- **Need the machines on one private network first?** Use a mesh VPN, then put
  Orbit on top of it — the two solve different layers.
- **Need to publish a service without opening inbound ports?** A managed tunnel
  does that; Orbit does not replace it.

---

## Categories

| Approach | Good at | What you still own | Relationship to Orbit |
| --- | --- | --- | --- |
| **Reverse proxy + identity-aware access** in front of a single DSH | The shortest path to reaching one instance safely; nothing new to learn. | Multi-node routing, node identity, eligibility rules, upgrade gating, per-node cookie isolation. | Orbit uses the same pattern as its front door and adds the control plane behind it. Not a competitor — a prerequisite you would build anyway. |
| **Generic web terminal** (exposing a shell or SSH session in a browser) | Giving browser access to a terminal on a machine. | Everything above the terminal: it is not a DSH control plane, has no node registry, no capability model, and no upgrade guard. | Different object. Orbit routes the DSH web application itself, not a shell. |
| **Managed tunnel** (publishing a local service through a provider) | Reaching a private service without inbound firewall changes. | The provider sits in your trust path, and identity/account handling comes from it; multi-node routing rules and upgrade gating are still yours. | Orbit is self-hosted end to end and keeps the trust path inside your deployment. They combine — a tunnel can carry the outer hop. |
| **Mesh VPN** (private network between your machines) | Private connectivity between hosts, including machines behind NAT. | Browser-friendly authentication, the DSH trust boundary, per-node routing decisions, upgrade discipline. | Complementary, different layer. Orbit assumes the node is reachable and focuses on who may reach it and under which conditions. |
| **Running DSH locally only** | Zero exposure, no operational surface. | Any remote access at all. | Orbit is the remote-access layer for exactly this setup. |

Two honest notes that cut the other way:

- A VPN or tunnel plus a reverse proxy genuinely covers **single-node** remote
  access. If that is your whole problem, stop there.
- Combining approaches is normal. Orbit does not require you to remove the VPN
  or tunnel you already trust; it does require the node endpoint to be reachable
  in v0.4 (see below).

---

## What Orbit adds that the alternatives do not have

- **Node identity and enrollment** — nodes are registered, credentialled, and
  revocable, with a tombstone reenrollment path rather than "whatever host is up".
- **Deterministic routing per node** — `n-<nodeId>.<routeDomain>`, derived from
  identity instead of a mutable "active node" session flag.
- **Signed hop-by-hop forwarding** — the Hub proves its identity to the node
  with `ORBIT-ROUTE-V1`; the node verifies before forwarding.
- **Five-condition eligibility** — `state=active`, `authenticated=ok`,
  `dshHealthy=ok`, `orbitCompatible=pass`, `reachable=ok`, all required.
- **Evidence-backed capabilities** — the Hub derives what a node can do from
  uploaded compatibility evidence, so a node cannot advertise capability it has
  not demonstrated.
- **Fail-closed routing** — an unavailable node returns an error; it never
  silently falls back to a different node.
- **Upgrade gating** — a candidate DSH version is validated against copied data
  on an isolated endpoint before it can replace a working deployment.
- **Per-node browser isolation** — host-only cookies prevent session bleed
  between distinct DSH instances.

---

## What DSH Orbit explicitly is not

- **Not a VPN** and not a network-transport replacement.
- **Not a tunnel service** and not a NAT-traversal solution in v0.4.
- **Not a web terminal multiplexer.** It routes the DSH application.
- **Not a fork of DeepSeek Harness.** DSH stays the runtime; compatibility
  patches are version-pinned, fail-closed, and temporary, with exit conditions.
- **Not a managed service.** You run it, you own the data and the trust path.
- **Not a promise of compatibility with untested DSH releases.** See the
  [DSH version policy](dsh-version-policy.md).
- **Not a credential store.** It does not store or distribute user credentials.

> **Reverse-connected nodes are not part of v0.4. They remain a v0.5 scope.**
> v0.4 routes only to server-reachable node endpoints, so a node behind
> carrier-grade NAT needs a VPN, a tunnel, or a v0.5 reverse connection.

---

## Choosing

Pick the smallest thing that solves your problem:

1. One machine, remote browser access → reverse proxy + identity-aware access.
2. Several machines, private network only → mesh VPN.
3. Several DSH instances, browser access, auditable routing and upgrade
   discipline → Orbit (optionally on top of 1 and 2).

If you are unsure whether Orbit is worth the additional moving parts for your
setup, open a Discussion and describe your topology — that is more useful than a
feature list.
