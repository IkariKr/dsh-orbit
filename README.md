# DSH Orbit

**DSH Orbit is a Hub-and-Node fleet layer and secure self-hosting layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).**

One Hub keeps a registry of your DSH machines. Each node keeps running its own DSH runtime, dials *out* to the Hub over HTTPS/WSS, and gets its own deterministic public hostname. Your phone pairs by scanning a QR code inside DSH Settings. The Hub is a control plane — DSH stays the execution runtime on every node.

> DSH Orbit is an independent community project. It is not affiliated with or endorsed by DeepSeek AI.

## Why

Running DSH on more than one machine today means juggling:

- a separate URL and session per machine, copied by hand;
- inbound ports, port forwarding, or a VPN appliance so remote clients can reach each machine;
- long-lived URLs or tokens handed to a laptop or phone, valid until you remember to rotate them.

DSH Orbit replaces that with a fleet model:

- **Nodes connect outbound only.** A node behind NAT (a NAS at home, a desktop behind CGNAT) registers with the Hub over an outbound HTTPS/WSS reverse connection — no inbound ports, no public IP per node, Ed25519 node identity ([RFC-0012](docs/rfc/0012-reverse-connected-nodes.md)).
- **Every node has one public name.** Each node is reachable at a deterministic authority `n-<32hex>.<routeDomain>` with fail-closed routing — a failed node route never silently serves another node ([RFC-0010](docs/rfc/0010-node-endpoint-and-routing.md)).
- **The phone pairs by scanning.** DSH Settings contains an "Orbit Remote & Fleet" panel that renders an inline-SVG QR with a 6-digit, 300-second, single-use pairing code. Scanning it opens the Hub landing page, verifies without credentials, and starts an operator session ([RFC-0016](docs/rfc/0016-dsh-plugin-integration-and-qr-pairing.md), [RFC-0017](docs/rfc/0017-hub-qr-pairing-landing.md)).
- **Upgrades stay guarded.** A candidate upgrade runner builds, verifies, and reports — it never promotes production on its own.

## How it fits together

```text
                         public DNS + TLS
                                |
                    authenticated gateway
                                |
   +----------------- Orbit Hub (control plane) ------------------+
   |   node registry | selector | operator UI | pairing engine   |
   +------^-------------------------------^-----------------------+
          | outbound HTTPS/WSS            | HTTPS
          | reverse connection             |
   +------+------+                 +------+------+
   |   Node A    |                 |   Node B    |
   | (NAS)       |                 | (desktop)   |
   | DSH runtime |                 | DSH runtime |
   +-------------+                 +-------------+

   Phone: DSH Settings -> "Orbit Remote & Fleet" -> QR
          -> https://<hub>/auth?token=<6-digit code> -> operator session
```

Core concepts:

| Concept | What it is |
| --- | --- |
| **Hub** | The control plane: SQLite-backed node registry, routing, selector, operator UI, pairing engine. Binds to loopback; a TLS gateway fronts it. |
| **Node** | A machine running DSH plus the Orbit node client. Holds an Ed25519 identity; reports heartbeat, health, and versions. |
| **Selector** | One familiar entry point that lists nodes and routes you to `n-<32hex>.<routeDomain>`. Fail-closed: no silent fallback. |
| **Pairing** | Two distinct flows: machine nodes pair with a one-time pair token via the node CLI; operator devices pair by scanning the 6-digit QR in DSH Settings. |

## Quickstart

All commands below are taken from the repository's own scripts and examples (`bin/`, `docker-registry/`). Placeholders (`orbit.example.com`, `nodes.example.com`) stand in for your public names.

Requirements: Node.js 22+, SQLite (via `node:sqlite`), and a public origin with TLS for the Hub.

### 1. Start a Hub

Run from a checkout of this repository:

```sh
export DSH_ORBIT_HUB_GATEWAY_SECRET="$(openssl rand -hex 32)"  # gateway-held assertion; never sent to clients
export DSH_ORBIT_HUB_ROUTE_DOMAIN="nodes.example.com"          # wildcard hostnames n-<32hex>.nodes.example.com
export DSH_ORBIT_HUB_QR_PAIRING_BASE_URL="https://orbit.example.com"  # public origin minted into QR URLs
node bin/dsh-orbit-hub.mjs
```

The Hub listens on `127.0.0.1:5445` by default and owns a SQLite registry. Pairing fails closed until the public base URLs are configured. For a containerized deployment, see `docker-registry/compose.example.yaml` (image tag via `DSH_ORBIT_REGISTRY_TAG`, Hub secret via environment) and [Registry deployment](docs/registry-deployment.md): the Hub binds loopback only, a gateway sharing its network namespace terminates TLS for the browser surface, and node traffic uses a private machine-ingress listener (`bin/dsh-orbit-machine-ingress.mjs`, port 5446) — machine routes are refused at the public gateway.

### 2. Bring up nodes

Mint a one-time token in the Hub operator surface (Tokens view), then on each node:

```sh
# NAT-restricted node (reverse connection, RFC-0012):
DSH_ORBIT_HUB_URL="https://orbit.example.com" \
DSH_ORBIT_PAIR_TOKEN="<one-time pair token>" \
node bin/dsh-orbit-node.mjs pair

# Server-reachable node (direct enrollment, RFC-0005):
DSH_ORBIT_HUB_URL="https://orbit.example.com" \
DSH_ORBIT_ENROLL_TOKEN="<one-time enrollment token>" \
node bin/dsh-orbit-node.mjs enroll

# Then run the daemon (heartbeat/report loop + reverse connection):
node bin/dsh-orbit-node.mjs
```

The node client persists its Ed25519 identity and Hub binding in `node-state.json` (mode-checked at startup) and forwards to the node-local DSH transport (default `http://127.0.0.1:3080`). `node bin/dsh-orbit-node.mjs status` and `doctor` report persisted and runtime state. See [Node registry client](docs/node-registry-client.md).

### 3. Pair a phone by scanning

1. Run DSH with the Orbit plugin. This repository's package is a DSH (Cordis) plugin — see `cordis.patch.yml`, the `dsh`/`dshClient` entries in `package.json`, and the [v0.9 plugin SOP](docs/sop/v0.9-dsh-plugin-and-qr-pairing-multistage-sop.md).
2. Open DSH Settings -> **Orbit Remote & Fleet**. The panel mints a 6-digit pairing code (300-second TTL, single-use) and renders it as an inline SVG QR — zero external requests. Repeated failed verifications lock the source IP out.
3. Scan the QR. It encodes `https://<hub>/auth?token=<code>`. The Hub landing page verifies the code, destroys it on first use, starts a short-lived `HttpOnly` operator session, and scrubs the token from the address bar. This is the only query-string shape exempted from the Hub's fail-closed fence; everything else stays gated.

### 4. Route to a node

Open the selector at the Hub, pick a node, and you are routed to its `n-<32hex>.<routeDomain>` authority — HTTP and WebSockets proxied without path rewriting, per-node cookie isolation, target scope always visible.

## Documentation map

| Area | Start here |
| --- | --- |
| Architecture and trust boundaries | [Architecture](docs/architecture.md), [Security model](docs/security-model.md) |
| Hub deployment and operations | [Registry deployment](docs/registry-deployment.md), [Configuration reference](docs/configuration-reference.md) |
| Node client and state | [Node registry client](docs/node-registry-client.md) |
| Design records | [docs/rfc/](docs/rfc/) — RFC-0001 through RFC-0017 (identity, registry, routing, reverse connection, fleet, scheduling, plugin, QR landing), [docs/adr/](docs/adr/) |
| Operating procedures | [docs/sop/](docs/sop/) — per-milestone multistage SOPs, operator and enrollment SOPs |
| Evidence | [docs/release-attestations/](docs/release-attestations/) per release, [docs/review/](docs/review/) for independent stage-gate reviews |
| Product direction | [Roadmap](docs/roadmap.md), [UX reference notes](docs/ux/) |
| Alternatives | [Comparison](docs/comparison.md) — Orbit vs. bare DSH, VPN/port-forwarding, generic tunnels |

## Status

- Current tagged release: **`v0.10.0-rc.1`** (signed tag). Milestones v0.1–v0.10 are implemented and engineering acceptance is closed.
- v0.10 closed with the M17 acceptance matrix at **17/17** (13 automated + 4 mounted on a real deployment, including a real phone scan). Every milestone went through staged independent review — Gate A, per-stage gates, Gate C, Final Review — recorded in `docs/review/`.
- **This is a release candidate, not production-stable.** Tag, promotion, and DNS cutover were treated as separately authorized steps.
- Deployment evidence comes from **one operator's two-node fleet** (a NAS and a desktop) running behind a reverse tunnel on a public apex. There is no third-party user base to point at, and none is claimed.
- Compatibility with DSH versions is explicit and fail-closed; see [Compatibility](docs/compatibility.md).

## Self-hosting layer (upgrades and compatibility)

The original v0.1–v0.4 layer — authenticated reverse-proxy access to the DSH configuration plane, upgrade guards, and smoke tests — remains part of the project and runs inside each deployment.

### Deploy the compatibility layer

```sh
cp .env.example .env                       # set DSH_PUBLIC_HOST and DSH_VERSION
mkdir -p secrets certs data workspace
openssl rand -hex 32 > secrets/dsh_proxy_auth
printf '%s' 'admin' > secrets/local_user
caddy hash-password --plaintext 'replace-this-password' > secrets/local_password_hash
# place origin certificate at certs/fullchain.pem and certs/privkey.pem

docker compose -f docker/compose.example.yaml build
docker compose -f docker/compose.example.yaml up -d
```

Gateway examples: [Caddy](proxy/Caddyfile.example), [Nginx](proxy/nginx.example.conf). The build installs the pinned DSH version and runs the compatibility patch in `--build` mode; unsupported source layouts fail the build instead of silently weakening security.

### Smoke-test a deployment

```sh
DSH_SMOKE_URL=https://dsh.example.com \
DSH_SMOKE_BASIC_USER=admin \
DSH_SMOKE_BASIC_PASSWORD='<local-password>' \
npm run smoke:auth
```

The authorization suite proves six outcomes against `settings.describe` (authenticated/expected origin allowed; unauthenticated, invalid credentials, unexpected `Origin`, `Sec-Fetch-Site: cross-site`, and forged gateway assertion all denied). `npm run smoke:settings`, `smoke:session`, and `smoke:terminal` cover the other surfaces. The suites never print credentials or response bodies.

### Upgrade a DSH version safely

Do not change the DSH version in place. The candidate runner orchestrates the manual sequence and never promotes production — the furthest it goes is `CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION`:

```sh
npm run upgrade -- preflight   # validate the configuration without touching anything
npm run upgrade -- candidate   # production snapshot, candidate build, isolated start, verification, report
npm run upgrade -- verify      # verification sequence plus report against a running candidate endpoint
npm run upgrade -- report      # regenerate the report from the run directory
```

Configuration comes from the environment (candidate and baseline identity, endpoints, snapshot hooks); see [Upgrade guide](docs/upgrade.md), [Compatibility](docs/compatibility.md), and [Downstream production deployment](docs/downstream-production.md). An optional terminal fence (`DSH_ORBIT_PATCH_DSH_SSH=1` opt-in, ADR-0001 legacy debt) is documented in [Third-party debt](docs/third-party-debt.md).

## Principles

- **Upstream first.** Use official DSH capabilities when they exist. Compatibility patches are a fallback, not a permanent fork.
- **Fail closed.** Unknown upstream layouts, patch mismatches, unexpected query strings, and route failures stop the path instead of silently weakening security.
- **No direct DSH exposure.** Remote administration sits behind an authenticated gateway; the Hub's management surface never shares the public path with node machine routes.
- **Versioned compatibility.** Each supported DSH version has an explicit compatibility contract and test coverage.
- **Portable deployment.** Public examples use placeholders and environment-driven configuration. Site-specific secrets and addresses stay outside the repository.

## Development

Requirements: Node.js 22 or newer.

```sh
npm test          # unit tests (fixtures and temp directories; no live DSH needed)
npm run check     # public-tree check + full test suite
```

## Scope

### In scope

- secure self-hosting patterns for DSH;
- a Hub-and-node fleet layer: registry, reverse-connected nodes, deterministic routing, selector;
- DSH-native plugin integration and scan-to-pair operator sessions;
- fleet workflows, scheduling, and upgrade guards with audit trails;
- deployment examples, smoke tests, and evidence-backed releases.

### Out of scope

- maintaining a fork of DeepSeek Harness;
- bypassing authentication for public deployments;
- storing or distributing user credentials;
- promising compatibility with untested DSH releases;
- silent cross-node failover or implicit broadcast execution.

## Contributing

Issues and pull requests are welcome. Changes that touch authentication, proxy trust, route authority, or privileged DSH RPCs should include negative tests as well as success-path tests. Design changes require an RFC first — see how existing milestones were run in [docs/rfc/](docs/rfc/) and [docs/review/](docs/review/).

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
