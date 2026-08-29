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
