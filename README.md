# DSH Orbit

DSH Orbit is a community-maintained self-hosting and fleet layer for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The project focuses on secure remote access, upgrade compatibility, and multi-node operation while keeping DeepSeek Harness as the upstream runtime.

> DSH Orbit is an independent community project. It is not affiliated with or endorsed by DeepSeek AI.

## Status

DSH Orbit is early-stage software and currently targets DeepSeek Harness `0.1.1-rc.2`.

The first release provides the deployment and compatibility layer needed to expose the DSH configuration plane behind an authenticated reverse proxy without publishing the DSH service directly.

Future releases are planned to add node discovery, endpoint selection, reverse-connected nodes, and fleet-level workflows. See [Roadmap](docs/roadmap.md).

## Principles

- **Upstream first.** Use official DSH capabilities when they exist. Compatibility patches are a fallback, not a permanent fork.
- **Fail closed.** Unknown upstream layouts or patch mismatches stop the build or startup path instead of silently weakening security.
- **No direct DSH exposure.** Remote administration is expected to sit behind an authenticated proxy or access layer.
- **Versioned compatibility.** Each supported DSH version has an explicit compatibility contract and test coverage.
- **Portable deployment.** Public examples use placeholders and environment-driven configuration. Site-specific secrets and addresses stay outside the repository.

## Current architecture

```text
Internet
   |
Identity-aware access layer
   |
Reverse proxy / authenticated gateway
   |
DSH Orbit compatibility layer
   |
DeepSeek Harness
```

DSH Orbit does not replace DSH authentication or authorization semantics wholesale. The current compatibility layer narrows remote configuration access to requests that satisfy the configured host, HTTPS forwarding, same-origin checks, and a proxy-held shared secret.

See [Security model](docs/security-model.md) for the trust boundary and deployment requirements.

## Quick start

### 1. Configure the deployment

Copy the example environment file and set `DSH_PUBLIC_HOST`:

```sh
cp .env.example .env
```

Create the local runtime directories and secrets expected by the example Compose file:

```sh
mkdir -p secrets certs data workspace
openssl rand -hex 32 > secrets/dsh_proxy_auth
printf '%s' 'admin' > secrets/local_user
caddy hash-password --plaintext 'replace-this-password' > secrets/local_password_hash
```

Place the origin certificate and private key at `certs/fullchain.pem` and `certs/privkey.pem`. The certificate must be valid for `DSH_PUBLIC_HOST` if an upstream proxy verifies the Caddy origin.

The files under `secrets/`, `certs/`, and `data/` are ignored by Git and must remain local.

### 2. Build

```sh
docker compose -f docker/compose.example.yaml build
```

The image build installs the selected DSH version and runs the compatibility patch in `--build` mode. Unsupported source layouts fail the build.

### 3. Start

```sh
docker compose -f docker/compose.example.yaml up -d
```

At runtime, the profile-local DSH client package is checked and patched before the web process starts. This is necessary because DSH profiles can contain their own copy of `@deepseek-ai/dsh-client-connection`.

Optional downstream hooks in `hooks/` run before each DSH Web start. They are intended for deployment-specific compatibility work that does not belong in the shared project. A failed hook stops startup.

### 4. Configure the reverse proxy

Examples are provided for:

- [Caddy](proxy/Caddyfile.example)
- [Nginx](proxy/nginx.example.conf)

The examples intentionally separate a trusted access-provider path from a local/basic-auth path. Do not accept an access-provider assertion header directly from arbitrary clients.

For Cloudflare Access deployments, point the tunnel directly at the loopback Caddy origin. If a separate LAN proxy also reaches Caddy, strip `Cf-Access-Jwt-Assertion` on that path as shown in the Nginx example.

### 5. Smoke-test settings

After authentication and routing are configured, test a settings read and a no-op write:

```sh
DSH_SMOKE_URL=https://dsh.example.com \
DSH_SMOKE_BASIC_USER=admin \
DSH_SMOKE_BASIC_PASSWORD='<local-password>' \
node scripts/smoke-settings.mjs
```

Use the authentication variables that match the path being tested. The script does not print credentials or settings secrets.

When the gateway rewrites the `Host` header to a public authority that differs from the smoke endpoint URL (for example a non-default rehearsal port), set `DSH_SMOKE_ORIGIN=https://dsh.example.com` so the same-origin positive control matches what a real browser would send.

### 6. Smoke-test authorization

Test the live authorization boundary of a running deployment against privileged RPCs:

```sh
DSH_SMOKE_URL=https://dsh.example.com \
DSH_SMOKE_BASIC_USER=admin \
DSH_SMOKE_BASIC_PASSWORD='<local-password>' \
npm run smoke:auth
```

Both credential variables are required: the supported auth path for this suite is the gateway's local Basic Auth path. The suite proves six outcomes against `settings.describe`:

| Case | Expected result |
| --- | --- |
| authenticated, expected origin | allowed |
| unauthenticated | denied |
| invalid credentials | denied |
| unexpected `Origin` | denied |
| `Sec-Fetch-Site: cross-site` | denied |
| forged `Cf-Access-Jwt-Assertion` on the local path | denied |

The suite never needs the internal proxy secret — the gateway injects it after authenticating the user, and exposing that secret to a client would itself be a failure. It exits non-zero when any case mismatches, and normal and failure output never include credentials or response bodies.

## Upgrade workflow

Do not update a production DSH instance by changing the package version in place.

The recommended flow is:

1. select a candidate DSH version;
2. build a candidate image;
3. require the compatibility patch to match exactly;
4. start the candidate with a copied data directory;
5. run settings, negative-auth, and pre-upgrade session-resume smoke tests;
6. snapshot production data;
7. promote the candidate only after the tests pass.

See [Upgrade guide](docs/upgrade.md), [Compatibility](docs/compatibility.md), and [Downstream production deployment](docs/downstream-production.md).

## Candidate upgrade runner

`npm run upgrade -- <command>` orchestrates the manual upgrade sequence as one explicit, fail-closed command. It never promotes production: the furthest it can go is `CANDIDATE PASSED - ELIGIBLE FOR MANUAL PROMOTION`, and promoting remains an operator action.

```sh
npm run upgrade -- preflight   # validate the configuration without touching anything
npm run upgrade -- candidate   # production snapshot, candidate build, isolated start, verification, report
npm run upgrade -- verify      # verification sequence plus report against a running candidate endpoint
npm run upgrade -- report      # regenerate the report from the run directory
```

Configuration comes from the environment. Candidate identity: `DSH_VERSION` (candidate DSH version), `DSH_CANDIDATE_ORBIT_REVISION` (the Orbit revision the candidate is built from), `DSH_CANDIDATE_IMAGE`, `DSH_CANDIDATE_DATA_ROOT`, `DSH_CANDIDATE_WORKSPACE_ROOT`, `DSH_UPGRADE_HOST_PORT` (the isolated loopback port). Baseline identity (the rollback target): `DSH_BASELINE_IMAGE`, `DSH_BASELINE_ORBIT_REVISION`, `DSH_BASELINE_DSH_VERSION`. Gateway and checks: `DSH_PUBLIC_HOST`, `DSH_SMOKE_URL` (the candidate endpoint), `DSH_SMOKE_BASIC_USER`/`DSH_SMOKE_BASIC_PASSWORD`, `DSH_SMOKE_SESSION_ID` (a pre-upgrade session), `DSH_SMOKE_ORIGIN` (when the gateway rewrites the Host), `DSH_DATA_ROOT` (production data), `DSH_SNAPSHOT_HOOK`. Optional: `DSH_ORBIT_VERSION`, `DSH_UPGRADE_PROJECT`, `DSH_UPGRADE_COMPOSE`, `DSH_UPGRADE_WORKDIR`, `DSH_SNAPSHOT_TIMEOUT_SECONDS`, `DSH_UPGRADE_GATEWAY_SERVICE` (default `caddy`), `DSH_UPGRADE_GATEWAY_CERT_TARGET` (default `/run/certs/fullchain.pem`, matching the public example compose), `DSH_UPGRADE_GATEWAY_KEY_TARGET` (default `/run/certs/privkey.pem`). Deployments whose gateway reads certificates elsewhere must set the two targets, and the base compose gateway must already mount a certificate at those targets.

Optional terminal fence (legacy third-party compatibility debt, ADR-0001 — freeze-only, no new features, removed once DSH provides a generic trusted-client/authenticated-proxy capability; see `docs/third-party-debt.md`): set `DSH_ORBIT_PATCH_DSH_SSH=1` (also passed into the candidate container) to patch the `@linxin666/dsh-ssh` loopback-only fence so the authenticated Orbit proxy path can open remote PTY terminals. The patch is version-pinned (default `0.3.2`, override with `DSH_SSH_PLUGIN_VERSION`), uses exact source matching, and keeps loopback access plus all other denials intact; `DSH_SSH_PLUGIN_ROOT` overrides the plugin location. With the fence enabled, the candidate verification sequence runs the terminal authorization smoke (`npm run smoke:terminal`) — 6 cases against the live endpoint — and a failed terminal gate blocks promotion eligibility.

The runner:

1. runs the production snapshot hook and denies promotion readiness when it fails; the failure is recorded in the run evidence, so regenerating a report cannot restore eligibility;
2. generates a compose override from the candidate specification (image, copied data and workspace roots, isolated loopback port) and verifies the *resolved* `docker compose config` against it — image, `/data` and `/workspace` mounts, published loopback port (`127.0.0.1` or `::1` only), project name, and a per-run candidate token must all match before anything is built or started;
3. generates a per-run gateway identity certificate (SAN matching the candidate endpoint host) and mounts it into the candidate gateway in place of the base certificate;
4. builds the candidate without replacing the last known-good image tag — the build fails on unsupported versions or source-layout mismatches — then starts it against the copied data on the isolated endpoint; production keeps running;
5. verifies the full identity chain before any check runs: the running stack carries this run's candidate token, and `DSH_SMOKE_URL` terminates at the candidate gateway (the TLS peer certificate must be the per-run identity certificate);
6. executes the verification sequence in a deterministic order (runtime readiness, patch verification, settings read, no-op settings write, live authorization smoke, existing-session resume, web/plugin routes, and the release-limited long-lived transport and terminal checks), with the smoke suites trusting the per-run certificate through `NODE_EXTRA_CA_CERTS`;
7. stops at the first required failure, marks the remaining checks `not_run`, and still produces a final sanitized report;
8. reports `compatibility` and `promotion readiness` separately: promotion readiness is eligible only when every required check passed, the exact candidate and baseline identities are recorded, and the snapshot completed; `verify` never evaluates promotion readiness;
9. exits `0` only for a passed candidate or a passing verification, `1` for a failure, and `2` for configuration or binding errors. The runner environment needs Docker, the compose plugin, and OpenSSL.

## Development

Requirements:

- Node.js 22 or newer

Run the unit tests:

```sh
npm test
```

Run repository validation:

```sh
npm run check
```

The test suite uses fixtures and temporary directories. It does not require a live DSH installation.

## Scope

### In scope

- secure self-hosting patterns for DSH;
- authenticated reverse-proxy compatibility;
- DSH upgrade guards and compatibility checks;
- deployment examples and smoke tests;
- future multi-node endpoint discovery and selection.

### Out of scope

- maintaining a fork of DeepSeek Harness;
- bypassing authentication for public deployments;
- storing or distributing user credentials;
- promising compatibility with untested DSH releases.

## Contributing

Issues and pull requests are welcome. Changes that touch authentication, proxy trust, or privileged DSH RPCs should include negative tests as well as success-path tests.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
