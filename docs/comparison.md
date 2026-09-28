# Comparing DSH Orbit with the alternatives

This page states, capability by capability, what DSH Orbit changes compared with the setups most self-hosters use today. The alternatives are good tools — the goal is to make the trade-offs explicit, not to score points. Every claim here describes Orbit as of `v0.10.0-rc.1` (release candidate).

The short version: Orbit is worth its cost when **more than one DSH machine** and **phones or other personal devices** are both in the picture. With a single machine and an existing access path you like, the alternatives below are often the simpler answer.

## 1. Bare DSH web + manually copying tokens

Running each DSH machine as-is and copying URLs, launch tokens, or sessions by hand.

| Capability | Bare DSH, by hand | With Orbit |
| --- | --- | --- |
| Reach N DSH machines | N separate URLs, each managed and remembered separately | One selector entry point; per-node public authority `n-<32hex>.<routeDomain>` |
| Machine identity | None at the fleet level; each DSH stands alone | Ed25519 node identity, heartbeat, health, and version reporting to the Hub |
| Node lifecycle | Manual (SSH in, restart, fix config) | Enroll / pair / re-enroll / rotate / revoke from the Hub surface |
| Getting a phone onto a DSH | Copy a long URL or token by hand onto the phone | Scan the QR in DSH Settings: 6-digit code, 300-second TTL, single-use, IP lockout on repeated failures |
| Session behavior across machines | Per-machine, whatever each DSH does | Per-node session isolation with a visible target scope; a failed node never silently serves another node's page |
| Multi-machine operations | Not available | Fleet workflows and schedules (v0.7/v0.8) with explicit target selection and audit |
| Extra components to run | None | A Hub (control plane) plus the node client and plugin |

What Orbit actually adds here is the fleet view and the pairing loop; a single DSH machine used from a single trusted browser does not need any of it.

## 2. VPN or port forwarding to reach a home-lab DSH

Putting each DSH machine (or the network behind one) on a VPN, or forwarding inbound ports to it.

| Capability | VPN / port forwarding | With Orbit |
| --- | --- | --- |
| Network posture | Inbound reachability per machine (forwarded port) or per network (VPN concentrator); the DSH port is exposed to whatever the tunnel admits | Nodes make **outbound HTTPS/WSS connections only**; the only public surface is the Hub behind an authenticated gateway |
| Per-machine addressing | You manage names, ports, and routes yourself (split DNS, hosts entries, port maps) | Deterministic public authority per node, issued and revoked by the Hub; wildcard route domain |
| Phone access | Install a VPN profile (or expose ports — not recommended) | Scan-to-pair from DSH Settings; no VPN profile, no stored long-lived URL |
| Front-door authentication | Whatever the VPN or DSH itself provides | Gateway-authenticated browser surface; node machine routes refused at the public gateway |
| Choosing which machine you are on | Switch VPN routes or bookmarks by hand | Selector with node status, compatibility, and reachability; fail-closed target preservation |
| Extra components to run | A VPN appliance or router configuration | A Hub, a public TLS entry, and a wildcard route domain |

If you already run a VPN you trust and only ever touch one DSH machine, a VPN is a perfectly good answer — Orbit's difference is per-node public authorities, outbound-only node connectivity, and the pairing flow, not raw reachability.

## 3. Generic tunnel tools (funnels, `cloudflared`, ngrok-style)

Pointing a tunnel product at a single machine's port and sharing the resulting URL.

| Capability | Generic tunnel to one machine | With Orbit |
| --- | --- | --- |
| Scope | One tunnel per machine/port; the fleet is a pile of URLs | One Hub covering the whole fleet; nodes are registry entries, not URLs |
| URL lifetime | The tunnel URL is a standing capability — anyone who holds it can use it until you change it | Admission is a 6-digit, 300-second, single-use pairing code; node identity is cryptographic and revocable |
| Who can be admitted | Whoever has the URL (unless you add your own auth in front) | Operator sessions minted only through the pairing verify path; machine nodes only through one-time pair tokens |
| Routing semantics | Address of the tunnel = address of the machine | Per-node authority with fail-closed fencing; no silent fallback, no path-prefix rewriting |
| Observability | Whatever the tunnel product shows | Registry-level heartbeat, health, capability, and audit trail per node |
| Extra components to run | A tunnel agent per machine | A Hub plus node clients; the Hub must be reachable on a public TLS origin |

Tunnel tools and Orbit can also coexist: a tunnel is one way to give the Hub its public entry; Orbit then manages what is behind it.

## What Orbit costs you

Honest ledger, so the comparison above is complete:

- **Run a Hub.** A control-plane process (SQLite-backed, loopback-bound) with a TLS gateway in front of its browser surface, plus a private machine-ingress path for nodes.
- **Provide a public entry.** A public origin with TLS for the Hub and a wildcard route domain (`*.nodes.example.com`-style) with certificates for per-node hostnames.
- **Maintain plugin compatibility.** The DSH plugin and compatibility layer are version-pinned and fail-closed: unsupported DSH layouts stop the build rather than degrade.
- **Review-first cadence.** Releases go through staged independent review before tagging; features arrive slower than in a typical single-maintainer tool.
- **Release-candidate maturity.** `v0.10.0-rc.1` is engineered and reviewed, with deployment evidence from one operator's two-node fleet. It is not production-stable and is not presented as such.

## When Orbit is probably not the right tool

- One DSH machine, one trusted access path, no phone use case — the added components buy you little.
- You want zero moving parts beyond DSH itself.
- You need fleet management for things that are not DSH nodes — Orbit only manages DSH.

If you tried Orbit and it was the wrong fit, that is worth hearing too — say so in [Discussions](https://github.com/IkariKr/dsh-orbit/discussions).
